// Link job language to a person's actual writing. These prompts never add claims.
const topics = [
  [/\b(?:reconcil\w*|rapprochements?)\b/u, 'Reconciliations', 'What records did you check against each other?'],
  [/\b(?:budgets?|budgeting|budgetaires?|forecast\w*|previsions?)\b/u, 'Budgets and forecasts', 'What budget or forecast did you help prepare?'],
  [/\b(?:variance\w*|ecarts?)\b/u, 'Variance analysis', 'What change did you investigate, and what did you find?'],
  [/\b(?:audit\w*|verification financiere)\b/u, 'Audit', 'What evidence did you check or prepare for an audit?'],
  [/\b(?:accounts? payable|comptes fournisseurs|supplier invoices?)\b/u, 'Accounts payable', 'Which invoices or supplier payments did you handle?'],
  [/\b(?:accounts? receivable|comptes clients|customer invoices?)\b/u, 'Accounts receivable', 'What part of billing or collections did you handle?'],
  [/\b(?:month.end|year.end|financial close|cloture)\b/u, 'Financial close', 'Which part of the close did you help complete?'],
  [/\b(?:financial report\w*|etats financiers|financial statements?)\b/u, 'Financial reporting', 'Which report did you prepare, and who used it?'],
  [/\b(?:excel|power query|power pivot)\b/u, 'Spreadsheet work', 'What did you build or check in a spreadsheet?'],
];
const words = value => value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const notExperience = /\b(?:no experience|never|not yet|haven.t|have not|no prior|want to learn|would like to learn|aucune experience|jamais)\b/u;
export function postingEvidence(posting, draft) {
  const lines = [
    ...draft.summary.split('\n').filter(Boolean).map(text=>({text,place:'Summary',index:-1})),
    ...draft.entries.flatMap((item,index)=>[item.title,...item.details.split('\n')].filter(Boolean)
      .map(text=>({text,place:item.title || item.section,index}))),
  ];
  const matched = [];
  let question = '';
  const job = words(posting);
  for (const [pattern,label,prompt] of topics) {
    if (!pattern.test(job)) continue;
    const quote = lines.find(line => { const normalized = words(line.text); return pattern.test(normalized) && !notExperience.test(normalized); });
    if (quote) matched.push({...quote,label});
    else if (!question) question = prompt;
  }
  return {matched,question};
}
