// A profile PDF has two independent reading orders. Keep the line positions until
// each column and section has been read. The original page text stays available.
const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’:]/gu, "'").replace(/'$/u, '').trim();
const labels = {
  Contact: ['contact', 'contact info', 'contact information', 'coordonnées', 'coordonnées de contact'],
  Skills: ['top skills', 'skills', 'principales compétences', 'compétences principales', 'compétences'],
  Languages: ['languages', 'langues'],
  Certifications: ['certifications', 'licenses & certifications', 'licences et certifications', 'certificats'],
  Awards: ['honors-awards', 'honors & awards', 'awards', 'prix et distinctions', 'distinctions'],
  Summary: ['summary', 'résumé', 'about', 'profil', 'présentation'],
  Experience: ['experience', 'expérience', 'expériences', 'expérience professionnelle'],
  Education: ['education', 'formation', 'formations'],
  Projects: ['projects', 'projets'],
  Volunteering: ['volunteering', 'volunteer experience', 'expériences de bénévolat', 'bénévolat'],
  Publications: ['publications'], Patents: ['patents', 'brevets'], Courses: ['courses', 'cours'],
};
const byLabel = new Map(Object.entries(labels).flatMap(([section, values]) => values.map(label => [fold(label), section])));
const sectionOf = text => byLabel.get(fold(text));
const sideSections = new Set(['Contact', 'Skills', 'Languages', 'Certifications', 'Awards', 'Publications', 'Patents', 'Courses']);
const profileFooter = /^(?:page\s+)?\d{1,3}\s*(?:of|sur|\/|de)\s*\d{1,3}$/iu;
const location = /^[\p{L}][\p{L}\p{M}'’. -]*(?:,\s*[\p{L}][\p{L}\p{M}'’. -]*){1,3}$/u;
const email = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}$/u;
const months = 'jan(?:uary|vier|v)?|feb(?:ruary)?|f[eé]vr?(?:ier)?|mar(?:ch|s)?|apr(?:il)?|avr(?:il)?|mai|may|ju[nl](?:e|y)?|juin|juil(?:let)?|aug(?:ust)?|ao[uû]t|sept?(?:ember|embre)?|oct(?:ober|obre)?|nov(?:ember|embre)?|d[eé]c(?:ember|embre)?';
const boundary = '(?:(?:' + months + ')\\.?\\s+)?(?:19|20)\\d{2}';
const range = new RegExp('^(' + boundary + '(?:\\s*(?:[–—-]|to|à|au)\\s*(?:' + boundary + '|present|current|présent|aujourd[’\']hui|en cours|actuel(?:lement)?))?)(?:\\s*\\([^)]*\\))?$','iu');
const duration = /^(?:\d+\s*(?:years?|months?|ans?|mois)(?:\s+|$))+$/iu;
const school = /\b(?:university|université|college|collège|institute|institut|academy|school|école|polytechnic|cégep)\b/iu;
const business = /\b(?:inc|ltd|group|groupe|bank|banque|corp|association|llp|partners|limited)\b/iu;
const person = /^[\p{L}\p{M}][\p{L}\p{M}.'’ -]{0,118}$/u;

export function profileLayout(rows, width) {
  const items = rows.flatMap(row => row.items);
  const side = items.filter(item => sideSections.has(sectionOf(item.text)));
  for (const contact of side.filter(item => sectionOf(item.text) === 'Contact')) {
    const aligned = side.filter(item => Math.abs(item.x - contact.x) < 18 && sectionOf(item.text) !== 'Contact');
    const main = items.filter(item => Math.abs(item.x - contact.x) > width * .18 &&
      ['Summary','Experience','Education','Projects','Volunteering'].includes(sectionOf(item.text)));
    const linked = items.some(item => /linkedin(?:\.com|\))/iu.test(item.text));
    if (!main.length) continue;
    const anchor = main[0].x;
    const distinctLabels=aligned.some(row=>/top skills|principales compétences|compétences principales/iu.test(row.text));
    const firstMainY=Math.min(...main.map(item=>item.y));
    const mainName=items.some(item=>Math.abs(item.x-anchor)<28 && item.y<firstMainY && item.height>=13 &&
      person.test(item.text) && !sectionOf(item.text));
    if (!mainName || (!linked && !distinctLabels)) continue;
    const left = contact.x < anchor;
    return {left, cut: ((left ? anchor : contact.x) - 6) / width};
  }
  return null;
}

export function profileColumns(rows, width, layout, first, assemble) {
  const body = [], sidebar = [];
  const line = (items, y) => ({
    text: assemble(items).trim(), y, x: items[0].x,
    end: Math.max(...items.map(i => i.x + i.width)), height: Math.max(...items.map(i => i.height || 10)),
  });
  const cut = layout.cut * width;
  for (const {y, items} of rows) {
    const side = items.filter(item => (item.x < cut) === layout.left);
    const main = items.filter(item => (item.x < cut) !== layout.left);
    if (side.length) sidebar.push(line(side, y));
    if (main.length) body.push(line(main, y));
  }
  // Some templates switch to a full-width left margin on continuation pages.
  if (!first && !sidebar.some(row => sideSections.has(sectionOf(row.text))) &&
      (!body.length || (layout.left && sidebar.some(row => ['Education','Experience'].includes(sectionOf(row.text)))))) {
    return {body: rows.map(row => line(row.items, row.y)), sidebar: []};
  }
  return {body, sidebar};
}

function entry(section, page, fields) {
  return {section, page, title:'', organization:'', dates:'', details:'', ...fields};
}

const listSections = new Set(['Skills','Languages']);
function sameLineGroup(before, after) {
  return before && after && after.y > before.y && after.y - before.y <= Math.max(before.height, after.height) * 1.48;
}

function contactFields(lines, draft, unresolved) {
  const addresses = draft.website ? draft.website.split(' | ') : [];
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i].text;
    let value = original.replace(/\s*\((?:Mobile|Home|Work|Cell|Téléphone mobile|Portable|Domicile|Travail|LinkedIn|Company|Personal|Entreprise|Site personnel|Portfolio)\)\s*$/iu,'').trim();
    if (!value) continue;
    if (value.includes('@') && !email.test(value)) {
      const next = lines[i + 1]?.text.trim();
      if (next && email.test(value + next)) { value += next; i++; }
    }
    if (email.test(value) && !draft.email) { draft.email = value; continue; }
    if (/^\+?[\d() .-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/iu.test(value) && value.replace(/\D/g,'').length >= 7 && !draft.phone) {
      draft.phone = value; continue;
    }
    if (/^(?:https?:\/\/|www\.|linkedin\.com\/in\/|[\w.-]+\.[a-z]{2,}(?:\/|$))/iu.test(value)) {
      const next = lines[i+1];
      if (next && /(?:\/|-)$/.test(value) && /^[\p{L}\p{N}_-]+$/u.test(next.text)) { value += next.text; i++; }
      if (!addresses.includes(value)) addresses.push(value);
      continue;
    }
    if (value === draft.name) continue;
    unresolved.push(original);
  }
  if (addresses.join(' | ').length <= 400) draft.website = addresses.join(' | ');
  else unresolved.push(...addresses);
}

function readList(section, rows, page, draft) {
  if (!rows.length) return;
  if (section === 'Contact') {
    const unresolved = [];
    contactFields(rows, draft, unresolved);
    if (unresolved.length) draft.entries.push(entry('Additional',page,{title:'Contact details',details:unresolved.join('\n')}));
    return;
  }
  if (listSections.has(section)) {
    const values = [];
    for (const row of rows) {
      if (values.length && ((values.at(-1).includes('(') && !values.at(-1).includes(')')) || /[&–-]$/u.test(values.at(-1)))) {
        values[values.length-1] += ' ' + row.text;
      } else values.push(row.text);
    }
    draft.entries.push(entry(section,page,{details:values.join('\n')}));
    return;
  }
  if (section === 'Certifications' || section === 'Awards') {
    let parts = [];
    const flush = () => {
      if (!parts.length) return;
      const name = parts.join(' ');
      draft.entries.push(entry(section,page,name.length <= 240 ? {title:name} : {details:name}));
      parts = [];
    };
    const gaps = rows.slice(1).map((row, i) => row.y - rows[i].y);
    const uniform = gaps.length && Math.max(...gaps) - Math.min(...gaps) < 2; 
    rows.forEach((row,i) => {
      const prev = rows[i-1];
      const wrap = prev && sameLineGroup(prev,row) &&
        (!uniform || /(?:[&–-]|\b(?:and|of|for|in|de|en))$/iu.test(prev.text) || /^\p{Ll}/u.test(row.text));
      if (!wrap) flush();
      parts.push(row.text);
    });
    flush();
    return;
  }
  draft.entries.push(entry('Additional',page,{title:section === 'Additional' ? '' : section,details:rows.map(r=>r.text).join('\n')}));
}

function dateOf(row) { return row && range.exec(row.text)?.[1]; }

function paragraphs(rows) {
  const result = [];
  for (const [index,row] of rows.entries()) {
    const prev = rows[index-1];
    if (prev && sameLineGroup(prev,row) && !/^[•–*-]\s/u.test(row.text) &&
        !/[.!?;:]$/u.test(prev.text)) result[result.length-1] += ' ' + row.text;
    else result.push(row.text);
  }
  return result.join('\n');
}

function readJobs(section, rows, page, draft, carry) {
  // Sidebar sections may have been read since the last role on the previous page.
  const previousRole = carry ? draft.entries.findLast(item => item.section === section && item.title && item.dates) : null;
  const jobs = [];
  for (const [index,row] of rows.entries()) {
    const dates = dateOf(row);
    if (!dates || index === 0) continue;
    const title = rows[index-1];
    if (dateOf(title) || title.text.length > 240 || title.text.endsWith('.')) continue;
    let start = index-1;
    if (duration.test(rows[start-1]?.text || '')) start--;
    let org = rows[start-1];
    const prev = rows[start-2];
    const distinct = org && (start === 1 || org.height > title.height + .6 || business.test(org.text) ||
      (prev && org.y - prev.y > org.height * 1.7 && title.y - org.y < org.y - prev.y));
    if (distinct && org.text.length <= 240 && !dateOf(org) && !location.test(org.text) &&
        !/^[•–*-]\s|[.!?:]$/u.test(org.text) && (!jobs.length || start-1 > jobs.at(-1).at)) start--;
    else org = null;
    jobs.push({start,at:index,title:title.text,org:org?.text,dates});
  }
  const leading = rows.slice(0,jobs[0]?.start ?? rows.length);
  if (leading.length) {
    // Keep an uncertain continuation tied to its own source page.
    draft.entries.push(entry(section,page,{details:paragraphs(leading)}));
  }
  let org = previousRole?.organization || '';
  for (const [i,job] of jobs.entries()) {
    if (job.org) org = job.org;
    const detail = rows.slice(job.at+1,jobs[i+1]?.start ?? rows.length);
    draft.entries.push(entry(section,page,{title:job.title,organization:org,dates:job.dates,details:paragraphs(detail)}));
  }
}

function readEducation(rows, page, draft) {
  const groups = [];
  for (const row of rows) {
    if (!groups.length || (school.test(row.text) && row.height >= groups.at(-1)[0].height-.5 && groups.at(-1).length>1)) groups.push([]);
    groups.at(-1).push(row);
  }
  for (const group of groups) {
    const data = entry('Education',page,{});
    const lines = [...group];
    if (school.test(lines[0].text) || (lines.length>1 && lines[0].height > lines[1].height+.5)) data.organization = lines.shift().text;
    const details = [];
    for (const row of lines) {
      const inline = /^(.*?)\s*[·|]\s*\(([^)]+)\)$/u.exec(row.text);
      const date = dateOf(row) || (inline && range.exec(inline[2])?.[1]);
      if (date && !data.dates) data.dates = date;
      const title = inline && date ? inline[1] : !date ? row.text : '';
      if (title && !data.title && title.length <= 240) data.title = title;
      else if (title) details.push(title);
    }
    data.details = details.join('\n');
    draft.entries.push(data);
  }
}

export function readProfilePages(pages, draft) {
  let mainSection = 'Header', sideSection = 'Additional';
  pages.forEach((source, index) => {
    const page = source.page || index+1;
    for (const column of ['body','sidebar']) {
      const rows = source.profile[column].filter(row => row.text && !profileFooter.test(row.text));
      let section = column === 'body' ? mainSection : sideSection;
      let block = [], carry = index > 0;
      const flush = () => {
        if (!block.length) return;
        if (section === 'Header') {
          const name = block.filter(row=>person.test(row.text) && !sectionOf(row.text)).sort((a,b)=>b.height-a.height)[0];
          if (name && !draft.name) draft.name = name.text;
          const other = block.filter(row=>row !== name);
          const place = other.find(row=>location.test(row.text));
          if (place && !draft.location) draft.location = place.text;
          const headline = paragraphs(other.filter(row=>row !== place));
          if (headline) draft.summary += (draft.summary ? '\n' : '') + headline;
        } else if (section === 'Summary') draft.summary += (draft.summary ? '\n\n':'')+paragraphs(block);
        else if (section === 'Experience' || section === 'Volunteering') readJobs(section,block,page,draft,carry);
        else if (section === 'Education') readEducation(block,page,draft);
        else if (section === 'Projects') draft.entries.push(entry(section,page,{details:paragraphs(block)}));
        else readList(section,block,page,draft);
        block = [];
      };
      for (const row of rows) {
        const kind = sectionOf(row.text);
        if (kind) { flush(); section=kind; carry=false; }
        else block.push(row);
      }
      flush();
      if (column === 'body') mainSection=section;
      else sideSection=section;
    }
  });
  return draft;
}
