import assert from 'node:assert/strict';
import {compareTerms, draftFromSource, draftTextSize, emptyDraft, MAX_ENTRIES, MAX_SOURCE, normalizeLinkedInProfile, readDraft} from '../src/draft.js';

const names = ['Émilie O’Connor', 'Ana-María Duarte', 'Jin Park', 'Zoë Rivière', 'Noémie Roy'];
const contacts = ['+44 (0)20 7946 0958', '+1 (416) 555-0100', '+33 1 42 68 53 00', '+49 30 123456', '+1 514 555 0100 ext. 42'];
const headings = ['EXPERIENCE', 'Work Experience', 'EMPLOYMENT HISTORY', 'EXPÉRIENCE PROFESSIONNELLE', 'PARCOURS PROFESSIONNEL'];
const bulletSigns = ['•', '-', '–', '—', '*'];
const roles = ['Financial Analyst', 'Senior Accountant', 'Internal Auditor', 'Analyste comptable', 'Finance Associate'];
const separators = [' | ', ' · ', ' • ', ' │ ', '\n'];
let checked = 0;
for (const [index, name] of names.entries()) {
  for (const [phoneIndex, phone] of contacts.entries()) {
    for (const heading of headings) {
      for (const bullet of bulletSigns) {
        for (const separator of separators) {
          const role = roles[(index + phoneIndex) % roles.length];
          const email = `candidate${index}@example.test`;
          const pageOne = [name + separator + email + separator + phone, '', heading, role + ' — Fictional Inc.', '2021–2024', bullet + ' Reconciled 320 ledger entries.', '', 'EDUCATION', 'Bachelor of Commerce', 'Fictional University', '2020'].join('\n');
          const pageTwo = ['CERTIFICATIONS', 'CPA Candidate', '', 'VOLUNTEERING', 'Finance Volunteer — Fictional Community Group', '2024–Present', bullet + ' Prepared monthly reports.', '', 'Additional Information', 'Fictional bilingual reporting project.'].join('\n');
          const draft = draftFromSource([{page: 1, text: pageOne}, {page: 2, text: pageTwo}]);
          assert.equal(draft.name, name);
          assert.equal(draft.email, email);
          assert.equal(draft.phone, phone);
          assert.equal(draft.sources[0].text, pageOne);
          assert.equal(draft.sources[1].text, pageTwo);
          assert.ok(draft.entries.some(entry => entry.section === 'Experience' && entry.title === role &&
            entry.organization === 'Fictional Inc.' && entry.dates === '2021–2024' && entry.details.includes('320 ledger entries')));
          assert.ok(draft.entries.some(entry => entry.section === 'Education' && entry.title === 'Bachelor of Commerce'));
          assert.ok(draft.entries.some(entry => entry.section === 'Certifications' && entry.title === 'CPA Candidate' && entry.page === 2));
          assert.ok(draft.entries.some(entry => entry.section === 'Volunteering' && entry.details.includes('monthly reports')));
          assert.deepEqual(readDraft(JSON.parse(JSON.stringify(draft))), draft);
          assert.ok(draftTextSize(draft) >= pageOne.length + pageTwo.length);
          assert.ok(compareTerms('Reconciled entries and SAP training', draft).includes('reconciled'));
          assert.ok(!compareTerms('Reconciled entries and SAP training', draft).includes('sap'));
          checked++;
        }
      }
    }
  }
}
assert.throws(() => draftFromSource([{page: 1, text: ' '}]), /No readable text/);
assert.throws(() => draftFromSource([{page: 1, text: 'x'.repeat(MAX_SOURCE + 1)}]), /too large/);
assert.throws(() => readDraft({...emptyDraft(), entries: Array(MAX_ENTRIES + 1).fill({section: 'Skills'})}), /not a Vita draft/);
assert.throws(() => readDraft({...emptyDraft(), entries: [{section: '__proto__'}]}), /unknown section/);
assert.throws(() => readDraft({...emptyDraft(), name: {text: 'malformed'}}), /invalid field/);
const expectedLink = 'https://www.linkedin.com/in/mara-dupont';
const validLinks = [
  ' linkedin.com/in/mara-dupont ',
  'https://www.linkedin.com/in/mara-dupont/?trk=share#intro',
  'http://ca.linkedin.com/in/mara-dupont',
  'HTTPS://M.LINKEDIN.COM/in/mara-dupont',
  'https://www.linkedin.com/in/mara-dupont?url=https://example.test',
];
for (const input of validLinks) assert.equal(normalizeLinkedInProfile(input), expectedLink);
assert.equal(normalizeLinkedInProfile('https://fr.linkedin.com/in/noémie-roy'), 'https://www.linkedin.com/in/no%C3%A9mie-roy');
const invalidLinks = [
  '', 'https://www.linkedin.com/company/example', 'https://www.linkedin.com/in/',
  'https://www.linkedin.com/in/mara-dupont/details', 'https://lnkd.in/test',
  'https://linkedin.com.example.test/in/mara-dupont', 'https://example.test/in/mara-dupont',
  'https://www.linkedin.com@fake.test/in/mara-dupont', 'https://linkedin.com:443/in/mara-dupont',
  'javascript:linkedin.com/in/mara-dupont', 'https://www.linkedin.com/in/a%2fb',
  'https://www.linkedin.com/in/%E0%A4%A', 'linkedin.com/in/foo bar',
  'https://www.linkedin.com/in/' + 'x'.repeat(101),
];
for (const input of invalidLinks) assert.equal(normalizeLinkedInProfile(input), null);
const portfolio = 'https://portfolio.example.test';
const contact = draftFromSource([{page: 1, text: ['Mara Dupont', portfolio + ' | ' + expectedLink].join('\n')}]);
assert.equal(contact.website, portfolio + ' | ' + expectedLink);
console.log(JSON.stringify({supportedDocumentVariants: checked, boundaryChecks: 5, linkChecks: validLinks.length + invalidLinks.length + 2, result: 'pass'}));
