const TYPES = new Set(['Education', 'Certifications', 'Additional']);
const TRANSCRIPT_HEADINGS = new Set([
  'academic transcript', 'official academic transcript', 'unofficial academic transcript', 'official transcript',
  'unofficial transcript', 'student transcript', 'transcript of academic record', 'academic record',
  'record of grades', 'releve de notes', 'releve de notes officiel', 'releve de notes non officiel', 'dossier academique',
]);
const CERTIFICATE_HEADINGS = new Set([
  'certificate', 'certification', 'certificate of completion', 'certificate of achievement',
  'certificate of participation', 'certificate of training', 'professional certificate', 'digital credential',
  'certificat', 'certification professionnelle', 'attestation', 'attestation de reussite', 'attestation de formation',
  'certificat de reussite', 'certificat de formation',
]);
const PROGRAM_LABELS = new Set(['program', 'programme', 'academic program', 'degree program', 'programme etudes', 'programme d etudes']);
const DEGREE_LABELS = new Set(['degree', 'diplome', 'degree sought', 'diplome vise']);
const STATUS_LABELS = new Set(['program status', 'degree status', 'statut du programme', 'etat du programme']);
const IN_PROGRESS = new Set(['in progress', 'currently enrolled', 'en cours', 'en cours d etudes']);
const UNKNOWN_VALUE = new Set(['none', 'unknown', 'not applicable', 'n a', 'not awarded', 'aucun', 'sans objet', 'non applicable', 'non attribue', ...IN_PROGRESS]);
const SCHOOL_LABELS = new Set([
  'institution', 'academic institution', 'educational institution', 'school', 'university', 'college',
  'etablissement', 'etablissement enseignement', 'etablissement d enseignement', 'ecole', 'universite', 'cegep',
]);
const CERTIFICATE_NAME_LABELS = new Set([
  'certificate name', 'certificate title', 'certification name', 'certification title', 'credential name',
  'credential title', 'nom du certificat', 'titre du certificat', 'nom de la certification',
]);
const COURSE_LABELS = new Set(['certificate', 'certification', 'credential', 'course', 'training', 'cours', 'formation']);
const ISSUER_LABELS = new Set([
  'issuer', 'issued by', 'issuing organization', 'issuing institution', 'awarded by', 'awarding body',
  'emetteur', 'delivre par', 'organisme emetteur', 'organisme de certification',
]);
const ISSUE_DATE_LABELS = new Set([
  'issue date', 'issued', 'issued on', 'date issued', 'date of issue', 'award date', 'completion date',
  'date completed', 'date of completion', 'date de delivrance', 'date emission', 'date d emission',
  'delivre le', 'date obtention', 'date d obtention',
]);

const ACADEMIC_NAME = /^(?:[\p{L}&.'’() -]+\s(?:University|College|Institute|Polytechnic|School)(?:\s(?:of|for|at)\s[\p{L}&.'’() -]+)?|(?:University|College|Institute|School)\s(?:of|for|at)\s[\p{L}&.'’() -]+|(?:Université|Collège|Cégep|École|Institut|Polytechnique)\s[\p{L}&.'’() -]+)$/iu;
const ISSUER_NAME = /^[\p{L}&.'’() -]+\s(?:Academy|Association|Council|Foundation|Institute|Society|Institute of [\p{L}&.'’() -]+)$/iu;
const ACADEMIC_TITLE = /^(?:Honou?rs?\s+)?(?:Bachelor|Master|Doctor)\s+of\s+[\p{L}][\p{L}\p{M}&.'’(), -]*$|^(?:Baccalauréat|Maîtrise|Doctorat)\s+(?:en|ès|de)\s+[\p{L}][\p{L}\p{M}&.'’(), -]*$/iu;
const SUBJECT_CERTIFICATE = /^(?:Certificate\s+(?:in|of (?:Achievement|Completion) in)|Certificat\s+(?:en|de compétence en))\s+\p{L}[\p{L}\p{M}\p{N}&.'’(), +/–-]*$/iu;
const COMPLETION_STATEMENT = /^(?:for (?:successful completion of|successfully completing|completing)|pour avoir (?:réussi|terminé)(?: avec succès)?)(?=$|[\s:])\s*:?[ \t]*(.*)$/iu;
const SENSITIVE_TEXT = /@|https?:\/\/|www\.|\b(?:gpa|grade point|date of birth|passport|student (?:id|number)|certificate (?:id|number)|credential (?:id|number)|cumulative|matricule|note cumulative)\b|\p{N}{5,}|\p{N}\s*%|\s\p{N}+[.,]\p{N}+$/iu;
const MONTHS = new Map([
  'jan january janv janvier', 'feb february fev fevr fevrier', 'mar march mars', 'apr april avr avril',
  'may mai', 'jun june juin', 'jul july juil juillet', 'aug august aout', 'sep sept september septembre',
  'oct october octobre', 'nov november novembre', 'dec december decembre',
].flatMap((names, month) => names.split(' ').map(name => [name, month + 1])));

function key(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function readLabel(text) {
  const label = /^([^:：]{1,45})\s*[:：]\s*(.+)$/u.exec(text);
  return label ? {name: key(label[1]), value: label[2].trim()} : null;
}

function value(text) {
  const candidate = text?.trim() ?? '';
  return candidate.length <= 160 && /\p{L}/u.test(candidate) && !SENSITIVE_TEXT.test(candidate)
    && !/[:：|<>\u0000-\u001F]/u.test(candidate) && !UNKNOWN_VALUE.has(key(candidate)) ? candidate : '';
}

function unique(values) {
  const distinct = new Map();
  for (const candidate of values) {
    if (candidate) distinct.set(candidate.normalize('NFC').toLowerCase().replace(/\s+/gu, ' '), candidate);
  }
  return [...distinct.values()];
}

function labeled(labels, names) {
  return unique(labels.filter(label => names.has(label.name)).map(label => value(label.value)));
}

function only(candidates) {
  return candidates.length === 1 ? candidates[0] : '';
}

function isIssueDate(text) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  const monthFirst = /^(\p{L}{3,10})\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?,?)?\s+(\d{4})$/iu.exec(text);
  const dayFirst = /^(\d{1,2})(?:er)?\s+(\p{L}{3,10})\.?\s+(\d{4})$/iu.exec(text);
  const year = Number(iso?.[1] ?? monthFirst?.[3] ?? dayFirst?.[3]);
  const month = iso ? Number(iso[2]) : MONTHS.get(key(monthFirst?.[1] ?? dayFirst?.[2] ?? ''));
  const day = Number(iso?.[3] ?? monthFirst?.[2] ?? dayFirst?.[1] ?? 1);
  return year >= 1900 && month >= 1 && month <= 12 && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parsePages(pages) {
  return (Array.isArray(pages) ? pages : []).slice(0, 50).flatMap((source, index) => {
    if (typeof source?.text !== 'string' || !source.text.trim()) return [];
    const page = Number.isSafeInteger(source.page) && source.page > 0 ? source.page : index + 1;
    const lines = source.text.slice(0, 250_000).split(/\r\n?|\n/u).map(line => line.trim())
      .filter(line => line && line.length <= 500).slice(0, 100);
    const labels = lines.flatMap(line => line.split(/[ \t]{2,}(?=[^:：]{1,45}[:：])/u).map(readLabel)).filter(Boolean);
    const headings = lines.slice(0, 14).map(key);
    const education = headings.some(heading => TRANSCRIPT_HEADINGS.has(heading));
    const certificate = headings.some(heading => CERTIFICATE_HEADINGS.has(heading))
      || labels.some(label => CERTIFICATE_NAME_LABELS.has(label.name))
      || lines.slice(0, 14).some(line => SUBJECT_CERTIFICATE.test(line));
    return [{page, lines, labels, education, certificate}];
  });
}

function educationEvidence(source) {
  const {lines, labels, education} = source;
  const degrees = labeled(labels, DEGREE_LABELS);
  const programs = labeled(labels, PROGRAM_LABELS);
  const titles = degrees.length ? degrees : programs.length ? programs
    : education ? unique(lines.slice(0, 18).filter(line => ACADEMIC_TITLE.test(line)).map(value)) : [];
  const schools = labeled(labels, SCHOOL_LABELS);
  const organization = only(schools.length ? schools : unique(lines.slice(0, 7).filter(line => ACADEMIC_NAME.test(line)).map(value)));
  const status = only(unique(labels.filter(label => STATUS_LABELS.has(label.name)).map(label => label.value)));
  const details = titles.length === 1 && IN_PROGRESS.has(key(status)) ? status : '';
  return {title: only(titles), organization, dates: '', details, ambiguous: titles.length > 1};
}

function statedCertificateTitles(lines) {
  return unique(lines.slice(0, 22).flatMap((line, index) => {
    const statement = COMPLETION_STATEMENT.exec(line);
    if (!statement) return SUBJECT_CERTIFICATE.test(line) ? [value(line)] : [];
    const named = value(statement[1] || lines[index + 1]);
    if (!named || CERTIFICATE_HEADINGS.has(key(named)) || /^(?:the requirements|all requirements|this course)\b/iu.test(named)) return [];
    return [named];
  }));
}

function certificateEvidence(source) {
  const {lines, labels, certificate} = source;
  const names = labeled(labels, CERTIFICATE_NAME_LABELS);
  const explicit = (names.length ? names : labeled(labels, COURSE_LABELS)).filter(name => !CERTIFICATE_HEADINGS.has(key(name)));
  const titles = explicit.length ? explicit : certificate ? statedCertificateTitles(lines) : [];
  const issuers = labeled(labels, ISSUER_LABELS);
  const organization = only(issuers.length ? issuers : certificate
    ? unique(lines.slice(0, 5).filter(line => ACADEMIC_NAME.test(line) || ISSUER_NAME.test(line)).map(value)) : []);
  const dates = unique(labels.filter(label => ISSUE_DATE_LABELS.has(label.name) && isIssueDate(label.value)).map(label => label.value));
  return {title: only(titles), organization, dates: titles.length === 1 ? only(dates) : '', details: '', ambiguous: titles.length > 1};
}

function inferredKind(sources) {
  const education = sources.some(source => source.education);
  const certification = sources.some(source => source.certificate);
  if (education === certification) return 'Additional';
  return education ? 'Education' : 'Certifications';
}

/** Suggest literal résumé fields from one supporting-document page. The user reviews every suggestion. */
export function suggestSupporting(pages, kind) {
  const sources = parsePages(pages);
  const type = TYPES.has(kind) ? kind : kind == null ? inferredKind(sources) : 'Additional';
  const entry = {section: type, title: '', organization: '', dates: '', details: ''};
  const firstPage = sources[0]?.page ?? 1;
  if (type === 'Additional') return {kind: type, entry, page: firstPage};

  const education = type === 'Education';
  const candidates = sources.filter(source => education ? !source.certificate : !source.education).map(source => ({
    page: source.page, ...((education ? educationEvidence : certificateEvidence)(source)),
  }));
  const titles = unique(candidates.map(candidate => candidate.title));
  if (titles.length > 1 || candidates.some(candidate => candidate.ambiguous)) return {kind: type, entry, page: firstPage};

  const strength = candidate => (candidate.title ? 4 : 0) + (candidate.organization ? 2 : 0) + (candidate.dates ? 1 : 0);
  const best = candidates.sort((one, other) => strength(other) - strength(one))[0];
  if (!best) return {kind: type, entry, page: firstPage};
  entry.title = best.title;
  if (unique(candidates.map(candidate => candidate.organization)).length === 1) entry.organization = best.organization;
  if (unique(candidates.map(candidate => candidate.dates)).length === 1) entry.dates = best.dates;
  if (unique(candidates.map(candidate => candidate.details)).length === 1) entry.details = best.details;
  return {kind: type, entry, page: best.page};
}
