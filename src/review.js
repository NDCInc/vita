// Keep the first view short. Every printed fact and every source page can be opened.
import {SECTIONS} from './draft.js';

export function reviewSections(draft) {
  return SECTIONS.flatMap(section => {
    const entries = draft.entries.filter(entry => entry.section === section);
    if (!entries.length) return [];
    const items = entries.flatMap(entry => [entry.title || entry.details.split('\n')[0] || entry.organization].filter(Boolean));
    return [{section, entries, sample:items.slice(0,2).join(' · ')}];
  });
}

export function checksFor(draft) {
  const checks = [];
  if (!draft.name.trim()) checks.push({label:'Add your name',target:'name'});
  if (!draft.email.trim() && !draft.phone.trim()) checks.push({label:'Add an email or phone number',target:'email'});
  else if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(draft.email.trim())) checks.push({label:'Check your email address',target:'email'});
  const blank = draft.entries.findIndex(entry => ['Experience','Volunteering','Projects'].includes(entry.section) && entry.title.trim() && !entry.details.trim());
  if (blank >= 0) checks.push({label:'Describe what you did as ' + draft.entries[blank].title,target:'details',index:blank});
  const unplaced = draft.entries.findIndex(entry=>entry.section==='Additional' && entry.page && !entry.title && entry.details);
  if (unplaced>=0) checks.push({label:'Choose a section for imported notes',target:'section',index:unplaced});
  if (!draft.entries.some(e=>[e.title,e.organization,e.details].some(x=>x.trim())) && !draft.summary.trim()) checks.push({label:'Add your first experience',target:'add-entry'});
  return checks;
}

export function nextQuestion(text, fallback) {
  if (/reconcil|rapproch|balanc(?:ed|ing)|month.end|clôture/iu.test(text)) return 'What did you check, and how often?';
  if (/forecast|budget|prévision|variance/iu.test(text)) return 'Who used your figures, or what decision did they help with?';
  if (/audit|contr[oô]l|verif|vérif/iu.test(text)) return 'What did you check, and what happened next?';
  if (/automat|spreadsheet|excel|power bi|tableur/iu.test(text)) return 'What did your tool help someone do more easily?';
  return fallback;
}
