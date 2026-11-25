import {readProfilePages} from './profile.js';
export const SECTIONS = ['Experience', 'Education', 'Projects', 'Volunteering', 'Certifications', 'Skills', 'Languages', 'Awards', 'Additional'];
export const PROFILE = ['name', 'email', 'phone', 'location', 'website', 'summary'];
export const MAX_SOURCE = 150_000;
export const MAX_ENTRIES = 250;
export const MAX_DRAFT_TEXT = 320_000;
const ENTRY_FIELDS = ['title', 'organization', 'dates', 'details'];
const limits = {name: 140, email: 240, phone: 100, location: 240, website: 400, summary: MAX_SOURCE, title: 240, organization: 240, dates: 160, details: MAX_SOURCE};

export function emptyDraft() {
  return {...Object.fromEntries(PROFILE.map(key => [key, ''])), entries: [], sources: []};
}

export function draftTextSize(draft) {
  const textFields = fields => fields.reduce((size, text) => size + text.length, 0);
  return textFields(PROFILE.map(key => draft[key])) +
    draft.entries.reduce((size, entry) => size + textFields(ENTRY_FIELDS.map(key => entry[key])), 0) +
    textFields(draft.sources.map(source => source.text));
}

function readString(value, key) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > limits[key]) throw new Error('This draft contains an invalid field.');
  return value.replaceAll('\0', '').replace(/\r\n?/g, '\n');
}

export function readDraft(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new Error('This file is not a Vita draft.');
  }
  const output = emptyDraft();
  for (const key of PROFILE) output[key] = readString(value[key], key);
  output.entries = value.entries.map(entry => {
    if (!entry || !SECTIONS.includes(entry.section)) throw new Error('This draft has an unknown section.');
    const result = {section: entry.section};
    for (const key of ENTRY_FIELDS) result[key] = readString(entry[key], key);
    if (Number.isInteger(entry.page) && entry.page > 0 && entry.page < 10000) result.page = entry.page;
    if (entry.supporting === true) {
      result.supporting = true;
      if (Number.isInteger(entry.supportingPage) && entry.supportingPage > 0 && entry.supportingPage < 10000) result.supportingPage = entry.supportingPage;
    }
    return result;
  });
  if (value.sources != null) {
    if (!Array.isArray(value.sources) || value.sources.length > MAX_ENTRIES) throw new Error('This draft contains invalid source pages.');
    let size = 0;
    output.sources = value.sources.map((source, index) => {
      if (!source || typeof source.text !== 'string') throw new Error('This draft contains an invalid source page.');
      size += source.text.length;
      if (size > MAX_SOURCE) throw new Error('This draft contains too much source text.');
      return {page: Number.isInteger(source.page) && source.page > 0 ? source.page : index + 1, text: readString(source.text, 'details')};
    });
  }
  if (draftTextSize(output) > MAX_DRAFT_TEXT) throw new Error('This draft contains too much text.');
  return output;
}

export function hasContent(draft) {
  return PROFILE.some(key => draft[key].trim()) ||
    draft.entries.some(hasEntryContent);
}

export function hasEntryContent(entry) {
  return ENTRY_FIELDS.some(key => entry[key].trim());
}

export function normalizeLinkedInProfile(value) {
  const input = value.trim();
  const address = input.match(/^(?:https?:\/\/)?([a-z0-9.-]+)(\/[^\s\\]*)$/i);
  if (!address || !/^(?:(?:www|m|[a-z]{2})\.)?linkedin\.com$/i.test(address[1])) return null;
  try {
    const path = /^\/in\/([^/?#]+)\/?(?:[?#].*)?$/u.exec(address[2]);
    const vanity = path && decodeURIComponent(path[1]);
    if (!vanity || vanity.length > 100 || !/^[\p{L}\p{N}_-][\p{L}\p{M}\p{N}_-]*$/u.test(vanity)) return null;
    return 'https://www.linkedin.com/in/' + encodeURIComponent(vanity);
  } catch {
    return null;
  }
}

const headings = new Map(Object.entries({
  profile: 'Summary', summary: 'Summary', 'professional summary': 'Summary', 'career summary': 'Summary', objectif: 'Summary', profil: 'Summary', 'resume professionnel': 'Summary',
  experience: 'Experience', 'work experience': 'Experience', 'professional experience': 'Experience', employment: 'Experience', 'employment history': 'Experience', 'relevant experience': 'Experience', 'experience professionnelle': 'Experience', 'experiences professionnelles': 'Experience', 'parcours professionnel': 'Experience',
  education: 'Education', 'education and training': 'Education', formation: 'Education', 'formation academique': 'Education', etudes: 'Education',
  projects: 'Projects', 'selected projects': 'Projects', projets: 'Projects',
  volunteering: 'Volunteering', volunteer: 'Volunteering', 'volunteer experience': 'Volunteering', benevolat: 'Volunteering', 'experience benevole': 'Volunteering',
  certifications: 'Certifications', credentials: 'Certifications', licenses: 'Certifications', licences: 'Certifications', 'professional designations': 'Certifications',
  "top skills": "Skills", "principales competences": "Skills", skills: 'Skills', 'technical skills': 'Skills', 'core competencies': 'Skills', competences: 'Skills', 'competences techniques': 'Skills',
  contact: 'Header', 'contact information': 'Header', coordonnees: 'Header', awards: 'Awards', 'honors-awards': 'Awards', languages: 'Languages', 'additional information': 'Additional', 'prix et distinctions': 'Awards', langues: 'Languages',
}));

function headingFor(text) {
  const key = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/:$/, '');
  return headings.get(key);
}

const emailPattern = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
const websitePattern = /(?:https?:\/\/[^\s|•]+|(?:www\.|linkedin\.com\/in\/)[^\s|•]+)/i;
const phonePattern = /^(?:(?:tel(?:ephone)?|phone)\s*:\s*)?(\+?[\d().\s-]+(?:\s*(?:x|ext\.?)\s*\d{1,7})?)$/iu;
const namePattern = /^(?:\p{L}[\p{L}\p{M}'’.-]*\s+){1,4}\p{L}[\p{L}\p{M}'’.-]*$/u;
const rolePattern = /\b(?:accountant|analyst|associate|assistant|manager|director|coordinator|intern|lead|engineer|consultant|bookkeeper|specialist|technician|auditor|controller|clerk|volunteer|developer|officer|supervisor|assistante|comptable|analyste|stagiaire|gestionnaire|technicien(?:ne)?|directeur|directrice|auditeur|auditrice)\b/i;
const qualificationPattern = /\b(?:degree|diploma|diplôme|bachelor|master|certificate|certificat|CPA|CFA|BCom|BBA|MSc|PhD|licence|certification|associate\s+of|baccalauréat|maîtrise|DESS|DEC)\b/i;
const datePattern = /^(?:(?:[\p{L}.]+\s+)?(?:19|20)\d{2})(?:\s*(?:\p{Pd}|to|à)\s*(?:(?:[\p{L}.]+\s+)?(?:19|20)\d{2}|present|current|présent|aujourd’hui))?$/iu;
const locationPattern = /^[\p{L}\p{M}.\s'-]{2,70},\s*[\p{L}\p{M}.\s'-]{2,35}$/u;
const organizationPattern = /\b(?:inc|ltd|llc|corp|corporation|group|bank|university|université|college|collège|cegep|cégep|academy|school|institute)\b/iu;
const bulletPattern = /^[•*–—-]\s/u;
const namedSections = new Set(['Experience', 'Education', 'Volunteering', 'Certifications', 'Projects']);

function fillHeader(draft, line, allowName) {
  const remaining = [];
  for (const [index, part] of line.split(/\s*(?:\||•|·|│)\s*/u).entries()) {
    const value = part.trim().replace(/\s*\((?:Mobile|Home|Work|Portable|Domicile|Travail|LinkedIn|Personal|Company)\)\s*$/iu, '').trim();
    if (!value) continue;
    const email = value.match(emailPattern)?.[0];
    const web = (value.match(websitePattern)?.[0] || (/\((?:Company|Personal)\)\s*$/iu.test(part) && /^[\w.-]+\.[a-z]{2,}(?:\/\S*)?$/iu.test(value) ? value : ''))?.replace(/[.,;)]+$/, '');
    const phone = value.match(phonePattern)?.[1]?.trim();
    if (allowName && index === 0 && value.length <= 85 && namePattern.test(value) && !rolePattern.test(value) && !headingFor(value)) draft.name = value;
    else if (!draft.email && email && /^(?:email\s*:\s*)?$/i.test(value.replace(email, '').trim())) draft.email = email;
    else if (web && /^(?:(?:website|linkedin)\s*:\s*)?$/i.test(value.replace(web, '').trim())) {
      const links = [...new Set(draft.website.split(' | ').filter(Boolean).concat(web))].join(' | ');
      if (links.length <= limits.website) draft.website = links;
      else remaining.push(value);
    }
    else if (!draft.phone && phone && phone.replace(/\D/g, '').length >= 7 && !datePattern.test(phone)) draft.phone = phone;
    else if (!draft.location && locationPattern.test(value) && !rolePattern.test(value)) draft.location = value;
    else remaining.push(value);
  }
  return remaining.join(' | ');
}

function looksLikeTitle(section, line) {
  if (!line || /^[•*–—-]/u.test(line) || /[.!?]$/.test(line)) return false;
  if (['Experience','Volunteering'].includes(section)) return line.length < 105 && rolePattern.test(line);
  if (['Education','Certifications'].includes(section)) return line.length < 140 && qualificationPattern.test(line);
  return false;
}

function titleAndOrganization(section, line) {
  if (!namedSections.has(section) || /^[•*–—-]/u.test(line)) return null;
  const parts = line.split(/\s+—\s+/u);
  if (parts.length !== 2) return null;
  const [title, organization] = parts.map(part => part.trim());
  if (!title || title.length > limits.title || !organization || organization.length > limits.organization ||
    datePattern.test(title) || datePattern.test(organization)) return null;
  if (!looksLikeTitle(section, title) && !organizationPattern.test(organization) &&
    ![title, organization].every(part => /^[\p{Lu}\p{N}]/u.test(part) && !/[.!?]$/.test(part))) return null;
  return {title, organization};
}

function entryFromLines(section, lines, page, label) {
  const pair = titleAndOrganization(section, lines[0]);
  const entry = {section, title: pair?.title || '', organization: pair?.organization || '', dates: '', details: '', page};
  if (section === 'Additional' && label) entry.title = label;
  const details = [];
  for (let i = pair ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    const organization = line.match(/^(?:company|employer|organization|institution|school|issuer|organisme|entreprise|établissement)\s*:\s*(.+)$/iu)?.[1];
    if (!entry.organization && organization && organization.length <= limits.organization) entry.organization = organization;
    else if (!entry.dates && datePattern.test(line) && namedSections.has(section)) entry.dates = line;
    else if (!entry.title && looksLikeTitle(section, line)) entry.title = line;
    else if (!entry.organization && entry.title && lines[i - 1] === entry.title &&
      /^[\p{Lu}\p{N}]/u.test(line) && line.length < 95 && !looksLikeTitle(section, line) &&
      (organizationPattern.test(line) || (datePattern.test(lines[i + 1] || '') && !/[.!?]$/.test(line)))) entry.organization = line;
    else details.push(line);
  }
  entry.details = details.join('\n');
  return entry;
}

export function continuationPages(draft) {
  const continued = new Set(draft.entries.filter(entry => !entry.title && !entry.organization && !entry.dates &&
    bulletPattern.test(entry.details) && ['Experience', 'Education', 'Projects', 'Volunteering'].includes(entry.section))
    .map(entry => entry.page));
  return draft.sources.slice(1).filter(source => continued.has(source.page) && bulletPattern.test(source.text.trimStart()))
    .map(source => source.page);
}

export function draftFromSource(pages) {
  if (!Array.isArray(pages)) throw new Error('No readable pages were returned.');
  const sources = pages.map(({page, text}, index) => ({
    page: Number.isInteger(page) && page > 0 ? page : index + 1,
    text: typeof text === 'string' ? text.replaceAll('\0', '').replace(/\r\n?/g, '\n') : '',
  }));
  if (sources.length > MAX_ENTRIES || sources.reduce((sum, item) => sum + item.text.length, 0) > MAX_SOURCE) {
    throw new Error('This file is too large to review in one draft. Paste the sections you want to use.');
  }
  if (!sources.some(source => source.text.trim())) {
    throw new Error('No readable text was found. Try a text-based file, paste the text, or enter it by hand.');
  }
  const draft = emptyDraft();
  draft.sources = sources;
  if (pages.length && pages.every(page => page.profile?.body && page.profile?.sidebar)) {
    return readDraft(readProfilePages(pages, draft));
  }
  let section = 'Header';
  let sectionLabel = '';
  let headerLine = 0;
  for (const { page, text } of sources) {
    let lines = [];
    let groupHasTitle = false;
    let groupHasDate = false;
    const flush = () => {
      if (!lines.length) return;
      if (section === 'Summary') draft.summary += (draft.summary ? '\n' : '') + lines.join('\n');
      else {
        const kind = section === 'Header' ? 'Additional' : section;
        draft.entries.push(entryFromLines(kind, lines, page, sectionLabel));
      }
      lines = [];
      groupHasTitle = false;
      groupHasDate = false;
    };
    const pageLines = text.split('\n').map(line => line.trim());
    // A line break inside an address is common in narrow contact columns.
    for (let i = 0; i < pageLines.length-1; i++) {
      const row = pageLines[i], next = pageLines[i+1];
      if (/^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+$/u.test(row) && !emailPattern.test(row) &&
          /^[\p{L}\p{N}.-]{2,40}$/u.test(next) && emailPattern.exec(row+next)?.[0] === row+next) {
        pageLines[i] = row+next;
        pageLines.splice(i+1,1);
      }
    }
    for (const [index, line] of pageLines.entries()) {
      if (!line) {
        if (section !== 'Summary') flush();
        else if (lines.length && lines.at(-1) !== '') lines.push('');
        continue;
      }
      const heading = headingFor(line);
      if (heading) {
        flush();
        section = heading;
        sectionLabel = heading === 'Additional' ? line.replace(/:$/, '') : '';
        continue;
      }
      if (section !== 'Header') {
        const pair = titleAndOrganization(section, line);
        const title = pair || looksLikeTitle(section, line);
        const dateAhead = title && [pageLines[index + 1], pageLines[index + 2]].some(candidate => datePattern.test(candidate || ''));
        if (groupHasTitle && (pair || (title && groupHasDate && dateAhead))) flush();
        if (title) groupHasTitle = true;
        if (datePattern.test(line)) groupHasDate = true;
        lines.push(line);
        continue;
      }
      const firstHeader = page === sources[0].page && headerLine++ < 4 && !draft.name;
      const remainder = page === sources[0].page && headerLine <= 7 ? fillHeader(draft, line, firstHeader) : line;
      if (remainder) lines.push(remainder);
    }
    flush();
  }
  return readDraft(draft);
}

const ignoredWords = new Set('about above after again also among and any are because been being both can come could down each even every for from have here how into its just like more most must near new not only onto other our out over per please role such than that their them then there these they this through too under upon use using very want was were what when where which who will with within would you your year years work working'.split(' '));

export function compareTerms(posting, draft) {
  const terms = text => text.toLocaleLowerCase('en-CA').match(/[\p{L}\p{N}][\p{L}\p{N}+#-]{2,}/gu) || [];
  const resume = terms([draft.summary, ...draft.entries.flatMap(entry => [entry.title, entry.organization, entry.details])].join(' '));
  const keywords = new Map();
  for (const term of terms(posting)) {
    if (ignoredWords.has(term) || /^\d/.test(term)) continue;
    keywords.set(term, (keywords.get(term) || 0) + 1);
  }
  const selected = [...keywords.keys()].sort((a, b) => keywords.get(b) - keywords.get(a)).slice(0, 20);
  const resumeTerms = new Set(resume);
  return selected.filter(term => resumeTerms.has(term));
}
