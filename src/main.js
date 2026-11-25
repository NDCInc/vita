import './styles.css';
import './brand.css';
import './workspace.css';
import {checksFor, nextQuestion, reviewSections} from './review.js';
import {postingEvidence} from './evidence.js';
import {attachDictation, cancelDictation} from './voice.js';
import {
  compareTerms, continuationPages, draftFromSource, draftTextSize, emptyDraft, hasContent, hasEntryContent, normalizeLinkedInProfile,
  MAX_DRAFT_TEXT, MAX_ENTRIES, MAX_SOURCE, PROFILE, readDraft, SECTIONS,
} from './draft.js';

const $ = id => document.getElementById(id);
const storageKey = 'vita:draft:v1';
const rememberKey = 'vita:remember:v1';
const state = {
  draft: emptyDraft(), history: [], candidate: null, remember: true,
  step: 'start', revision: 0, importRun: 0, previewRun: 0,
  supporting: [], supportRun: 0, supportLoading: false,
};
const maxSupportingDocuments = 5;
const supportCategories = [['Education', 'Education'], ['Certifications', 'Certifications'], ['Additional', 'Other']];
let documentModule;
let pdfBytes;
let pdfCache;
let pdfViewer;
let pdfViewRange;
let pdfZoomed = false;
let savedTimer;
let editSnapshot;
let draftLoadIssue = false;
let lastStored = null;
let storageConflict = false;
let scanTask = null;
let incomingFiles = [];
let extraFiles = [];

const documents = () => documentModule ||= import('./documents.js').catch(error => {
  documentModule = undefined;
  throw error;
});

function initialState() {
  try {
    state.remember = localStorage.getItem(rememberKey) !== 'off';
    if (!state.remember) return;
    const saved = localStorage.getItem(storageKey);
    lastStored = saved;
    if (!saved) return;
    const record = JSON.parse(saved);
    state.draft = readDraft(record.draft);
    if (record.previous) {
      try {
        state.history = [readDraft(record.previous)];
      } catch {
        // A damaged undo snapshot must not obscure the current draft.
      }
    }
  } catch {
    draftLoadIssue = true;
  }
}

function status(message = '', kind = '') {
  $('status').textContent = message;
  $('status').dataset.kind = kind;
  $('status').hidden = !message;
}

function persistDraft() {
  clearTimeout(savedTimer);
  savedTimer = undefined;
  try {
    localStorage.setItem(rememberKey, state.remember ? 'on' : 'off');
    if (!state.remember) {
      localStorage.removeItem(storageKey);
      lastStored = null;
      storageConflict = false;
      $('storage-conflict').hidden = true;
      $('save-state').textContent = 'Your draft is open for this session.';
      return;
    }
    if (storageConflict || localStorage.getItem(storageKey) !== lastStored) {
      storageConflict = true;
      $('storage-conflict').hidden = false;
      $('save-state').textContent = 'Your edits are open in this tab.';
      return;
    }
    const value = JSON.stringify({draft:state.draft, previous:state.history.at(-1)});
    localStorage.setItem(storageKey, value);
    lastStored = value;
    $('save-state').textContent = 'Saved on this device.';
  } catch {
    $('save-state').textContent = 'This browser can’t save your changes. Download a Vita backup to keep them.';
  }
}

function updateUndo() {
  $('undo').disabled = !state.history.length;
}

function snapshot() {
  state.history.push(structuredClone(state.draft));
  if (state.history.length > 5) state.history.shift();
  updateUndo();
}

function changed(immediate = false) {
  $('job-result').replaceChildren();
  state.revision++;
  pdfCache = undefined;
  renderChecks();
  $('continue-wrap').hidden = !hasContent(state.draft);
  clearTimeout(savedTimer);
  if (immediate) persistDraft();
  else savedTimer = setTimeout(persistDraft, 160);
}

function replaceDraft(next) {
  snapshot();
  state.draft = next;
  editSnapshot = null;
  changed(true);
  renderDraft();
}

function showStep(step, {focus = true, clearStatus = true} = {}) {
  if (step !== state.step) cancelDictation();
  if (step === 'download' && (state.candidate || state.supporting.length || state.supportLoading)) {
    showStep('review', {focus:false});
    const heading = state.candidate ? $('import-review-heading') : $('support-heading');
    status('Finish or cancel the import before downloading.');
    heading.focus();
    return;
  }
  if (step !== state.step && scanTask) closeScan();
  if (state.step === 'download' && step !== 'download') cancelPreview();
  state.step = step;
  for (const button of document.querySelectorAll('[data-step]')) {
    if (button.dataset.step === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  for (const name of ['start', 'review', 'download']) $(name + '-screen').hidden = name !== step;
  if (clearStatus) status();
  if (focus) {
    $(step + '-heading').focus({preventScroll: true});
    window.scrollTo(0, 0);
  }
  if (step === 'download') preparePreview();
}

function make(tag, text = '', attrs = {}) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  return element;
}

function sourceDetails(sources) {
  const root = document.createDocumentFragment();
  sources.forEach(({page, text}) => {
    const details = make('details');
    details.append(make('summary', 'Original text · page ' + page));
    details.append(make('pre', text || 'No readable text on this page.', {class: 'source-text', tabindex: '0'}));
    root.append(details);
  });
  return root;
}

function renderCandidate() {
  const root = $('candidate-preview'), identity = $('candidate-identity'), notesBox = $('import-notes');
  root.replaceChildren();
  identity.replaceChildren();
  notesBox.replaceChildren();
  $('import-scan').replaceChildren();
  const candidate = state.candidate;
  $('import-review').hidden = !candidate;
  $('editor-layout').hidden = !!candidate;
  document.querySelector('[data-go-download]').hidden = !!candidate;
  $('review-heading').textContent = candidate ? 'Check your import' : 'Edit your résumé';
  $('review-hint').textContent = candidate ? candidate.label : 'Select an entry to edit it.';
  if (!candidate) return;
  const {draft,notes} = candidate;
  const replacing=hasContent(state.draft);
  $('import-review-heading').textContent=replacing?'Replace your current draft?':'Ready to edit';
  $('apply-import').firstChild.textContent=replacing?'Replace and edit ':'Edit my résumé ';
  $('import-info').textContent = (hasContent(state.draft) ? 'This will replace the draft on this device. You can undo it.' : 'You can edit every detail in the next step.') +
    (extraFiles.length ? ' Next, review '+extraFiles.length+(extraFiles.length===1?' supporting file.':' supporting files.') : '');
  identity.append(make('h2', draft.name || 'Your imported résumé'));
  const contacts = [draft.email, draft.phone, draft.location, ...draft.website.split(' | ')].filter(Boolean);
  if (contacts.length) {
    const contactList = make('ul','',{class:'contact-list','aria-label':'Contact details'});
    for (const detail of contacts) contactList.append(make('li', detail));
    identity.append(contactList);
  }
  function addGroup(label, sample, entries) {
    const group = make('details','',{class:'import-group'});
    const summary = make('summary');
    summary.append(make('strong',label),make('span',sample,{class:'group-sample'}));
    group.append(summary);
    for (const item of entries) {
      const detail = make('div','',{class:'group-detail'});
      if (item.title) detail.append(make('h3',item.title));
      const context = [item.organization,item.dates].filter(Boolean).join(' · ');
      if (context) detail.append(make('p',context));
      if (item.details) detail.append(make('p',item.details));
      if (item.page) detail.append(make('small','Page '+item.page));
      group.append(detail);
    }
    root.append(group);
  }
  if (draft.summary) addGroup('Summary', draft.summary.split('\n')[0],[{details:draft.summary}]);
  for (const {section,entries,sample} of reviewSections(draft)) addGroup(section,sample,entries);
  if (notes.length) {
    const check = make('details','',{class:'import-cautions'});
    check.open = notes.some(note=>/no readable|scan|could not/iu.test(note));
    check.append(make('summary','Details to check ('+notes.length+')'));
    const list = make('ul');
    for (const note of notes) list.append(make('li',note));
    check.append(list); notesBox.append(check);
  }
  if (draft.sources.length) {
    const original = make('details','',{class:'original-disclosure'});
    original.append(make('summary','See original text'),sourceDetails(draft.sources));
    notesBox.append(original);
  }
  if (candidate.scan) {
    const button = make('button','Read scanned pages',{type:'button', class:'secondary'});
    button.addEventListener('click',()=>offerScan(candidate.scan.file,candidate.scan.result));
    $('import-scan').append(button);
  }
}

function beginImport() {
  closeScan();
  incomingFiles = []; extraFiles = []; $('file-set').hidden = true;
  state.candidate = null;
  renderCandidate();
  return ++state.importRun;
}

function stageDraft(draft, label, notes = [], scan = null) {
  state.candidate = {draft, label, notes, scan};
  renderCandidate();
  showStep('review');
  $('import-review-heading').setAttribute('tabindex', '-1');
  $('review-heading').focus({preventScroll:true});
}

function openPanel(panel, button) {
  for (const [id, trigger] of [['paste-panel', 'paste-start'], ['guide-panel', 'start-fresh'], ['linkedin-panel', 'linkedin-start']]) {
    const open = id === panel;
    $(id).hidden = !open;
    $(trigger).setAttribute('aria-expanded', String(open));
  }
  $(button).focus();
}

function linkedInOnly(draft) {
  return !hasContent({...draft, website: ''}) && normalizeLinkedInProfile(draft.website);
}

function linkedInError(message = '') {
  const feedback = $('linkedin-error');
  feedback.hidden = !message;
  feedback.textContent = message;
  if (message) $('linkedin-url').setAttribute('aria-invalid', 'true');
  else $('linkedin-url').removeAttribute('aria-invalid');
}

function stageSource(pages, label, warnings = [], scan = null) {
  const draft = draftFromSource(pages);
  if (!draft.website) draft.website = linkedInOnly(state.draft) || '';
  const notes = warnings.map(warning => typeof warning === 'string' ? warning : warning?.message).filter(Boolean);
  if (draft.entries.some(entry => entry.section === 'Additional')) {
    notes.push('Check text under Additional and move it to the right section if needed.');
  }
  const carryover = continuationPages(draft);
  if (carryover.length) {
    notes.push('Check whether the first bullet on ' + (carryover.length === 1 ? 'page ' : 'pages ') + carryover.join(', ') + ' belongs to an entry on the previous page.');
  }
  stageDraft(draft, label, notes, scan);
}

function closeScan() {
  scanTask?.controller?.abort();
  scanTask = null;
  $('scan-panel').hidden = true;
  $('read-scan').disabled = false;
  $('scan-status').textContent = '';
}
function offerScan(file,result,record = null) {
  closeScan();
  scanTask = {file,result,record};
  $('scan-panel').hidden = false;
  $('scan-hint').textContent = 'Read printed English and French from '+file.name+' on this device.';
  $('scan-title').focus();
}
$('cancel-scan').addEventListener('click',() => {
  const pendingRecord = scanTask?.record;
  closeScan();
  const target = pendingRecord ? $('support-heading') : state.candidate ? $('import-review-heading') : $('source-text');
  (target.offsetParent ? target : $('start-heading')).focus();
});
$('read-scan').addEventListener('click',async () => {
  const job = scanTask;
  if (!job || job.controller) return;
  const controller = new AbortController();
  job.controller = controller;
  $('read-scan').disabled = true;
  $('scan-status').textContent = 'Loading the scan reader…';
  try {
    const {recognizeFile} = await import('./scan.js');
    if (scanTask !== job) return;
    const result = await recognizeFile(job.file,job.result.pages,{signal:controller.signal, progress:text=>{
      if (scanTask === job) $('scan-status').textContent=text;
    }});
    if (scanTask !== job) return;
    if (job.record) {
      const record = job.record;
      if (!state.supporting.includes(record)) { closeScan(); return; }
      const suggestion = {...record,pages:result.pages};
      await supportSuggestion(suggestion);
      if (scanTask !== job || !state.supporting.includes(record)) return;
      for (const [key,value] of Object.entries(record.entry)) {
        if (value && (key !== 'section' || record.entry.section !== 'Additional')) suggestion.entry[key]=value;
      }
      Object.assign(record,{pages:result.pages,entry:suggestion.entry,page:suggestion.page,notes:result.warnings,scan:null});
      closeScan(); renderSupporting(); showStep('review');
      $('support-heading').focus(); supportMessage('The scan is ready. Choose the details you want to add.');
    } else {
      const retained = (job.result.warnings || []).filter(note=>!/no readable text/iu.test(note));
      if (!extraFiles.length && isSupportingSource(result.pages)) {
        closeScan(); state.candidate=null; renderCandidate();
        await openSupporting([job.file],new Map([[job.file,{...result,text:result.pages.map(p=>p.text).join('\n')}]]));
      } else {stageSource(result.pages, job.file.name, [...retained,...result.warnings]);closeScan();}
    }
  } catch (error) {
    if (scanTask !== job) return;
    $('scan-status').textContent = error.message || 'Try a clearer copy or paste the text.';
    job.controller = null;
    $('read-scan').disabled = false;
  }
});
async function openRésumé(file, extras = [], explicit = false) {
  if (!file) return;
  if (/\.(?:vita|json)$/iu.test(file.name)) return openPortable(file,extras);
  const run = beginImport();
  extraFiles = extras;
  status('Reading ' + file.name + '…');
  try {
    const result = await (await documents()).importDocument(file);
    if (run !== state.importRun) return;
    const pages = Array.isArray(result.pages) && result.pages.length ? result.pages : [{page: 1, text: result.text}];
    if (!explicit && !extras.length && isSupportingSource(pages)) {
      extraFiles=[];
      await openSupporting([file],new Map([[file,result]]));
      return;
    }
    if (result.draft) {
      const next = readDraft({...result.draft,sources:pages});
      if (!next.website) next.website = linkedInOnly(state.draft) || '';
      stageDraft(next,file.name,result.warnings || []);
      return;
    }
    const missing = pages.some(page => !page.text.trim());
    if (missing && !result.text.trim() && result.scannable) {
      status('No readable text was found. Your current draft is unchanged.', 'error');
      openPanel('paste-panel', 'source-text');
      offerScan(file, result);
      return;
    }
    stageSource(pages, file.name, result.warnings || [], missing && result.scannable ? {file,result} : null);
  } catch (error) {
    if (run !== state.importRun) return;
    showStep('start', {focus: false, clearStatus: false});
    status((error.message || 'This file could not be read.') + ' Your current draft is unchanged.', 'error');
    openPanel('paste-panel', 'source-text');
    if (extras.length) {
      const recover=make('button','Use the supporting files',{type:'button',class:'text-button'});
      recover.addEventListener('click',()=>{extraFiles=[];openSupporting(extras);},{once:true});
      $('status').append(document.createTextNode(' '),recover);
    }
  }
}

async function openPortable(file,extras=[]) {
  if (!file) return;
  const run = beginImport();
  extraFiles=extras;
  try {
    if (file.size > 3_000_000) throw new Error('This file is too large for a Vita draft.');
    const contents = await file.text();
    if (run !== state.importRun) return;
    let attempt;
    try {
      attempt = JSON.parse(contents.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('This file is not a readable Vita draft.');
    }
    if (attempt?.format !== 'vita' || attempt?.version !== 1) throw new Error('This file is not a supported Vita draft.');
    stageDraft(readDraft(attempt.draft), file.name);
  } catch (error) {
    if (run !== state.importRun) return;
    status(error.message + ' Your current draft is unchanged.', 'error');
  }
}

function inputField(labelText, field, value, max, {area = false, full = false, group = 'field'} = {}) {
  const label = make('label', labelText, full ? {class: 'full'} : {});
  const input = make(area ? 'textarea' : 'input', '', {['data-' + group]: field, maxlength: String(max)});
  if (area) input.rows = 4;
  input.value = value;
  label.append(input);
  return label;
}

function supportMessage(message = '') {
  $('support-progress').textContent = message;
}

function selectSupportButton() {
  $('apply-support').disabled = state.supportLoading || !state.supporting.some(record => record.selected);
}

function emptySupportEntry() {
  return {section: 'Additional', title: '', organization: '', dates: '', details: ''};
}

function renderSupporting(open = state.supporting.length > 0) {
  $('support-review').hidden = !open;
  selectSupportButton();
  const list = $('support-files');
  list.replaceChildren();
  state.supporting.forEach((record, index) => {
    const block = make('article', '', {class: 'entry', 'data-support-index': index, 'aria-label': 'Supporting document ' + (index + 1)});
    block.append(make('h3', record.name));
    for (const note of record.notes) block.append(make('p', note, {class: 'field-hint support-note'}));
    if (!hasEntryContent(record.entry)) {
      block.append(make('p', 'Choose a category and enter the details you want to add.', {class: 'field-hint support-note'}));
    }

    const fields = make('div', '', {class: 'fields'});
    const category = make('label', 'Category');
    const types = make('select', '', {'data-support-field': 'section'});
    for (const [value, label] of supportCategories) types.append(make('option', label, {value}));
    types.value = record.entry.section;
    category.append(types);
    fields.append(
      category,
      inputField('Title or qualification', 'title', record.entry.title, 240, {group: 'support-field'}),
      inputField('Organization or school', 'organization', record.entry.organization, 240, {group: 'support-field'}),
      inputField('Date', 'dates', record.entry.dates, 160, {group: 'support-field'}),
      inputField('Details', 'details', record.entry.details, 5000, {area: true, full: true, group: 'support-field'}),
    );
    block.append(fields);
    if (record.scan) {
      const read = make('button','Read text from scan',{type:'button',class:'secondary compact'});
      read.addEventListener('click',()=>offerScan(record.scan.file,record.scan.result,record));
      block.append(read);
    }
    if (record.pages.some(page => page.text.trim())) block.append(sourceDetails(record.pages));
    else {
      const paste = make('details', '', {class: 'support-paste'});
      paste.append(make('summary', 'Paste text from this document'));
      const label = make('label', 'Document text');
      const input = make('textarea', '', {rows: '4', maxlength: String(MAX_SOURCE), 'data-support-paste-input': ''});
      label.append(input);
      paste.append(label, make('button', 'Suggest from text', {type: 'button', class: 'secondary', 'data-support-paste': ''}));
      block.append(paste);
    }

    const include = make('label', '', {class: 'support-selection'});
    const checkbox = make('input', '', {type: 'checkbox', 'data-support-selected': ''});
    checkbox.checked = record.selected;
    include.append(checkbox, document.createTextNode(' Add this entry to my résumé'));
    block.append(include);
    list.append(block);
  });
  attachDictation(list);
}

async function supportSuggestion(record, kind) {
  const {suggestSupporting} = await import('./supporting.js');
  const suggested = suggestSupporting(record.pages, kind);
  record.entry = {...emptySupportEntry(), ...suggested.entry};
  record.page = suggested.page;
}

function isSupportingSource(pages) {
  const text = pages.map(page=>page.text).join('\n');
  return !pages.some(page=>page.profile) && !/^\s*(?:work experience|professional experience|experience|expérience professionnelle|skills|top skills)\s*$/imu.test(text) &&
    /^\s*(?:(?:(?:un)?official |academic |student )*(?:academic )?transcript(?: of academic record)?|certificate of (?:completion|achievement|participation|training)|relevé de notes(?: non officiel| officiel)?|attestation de (?:réussite|formation))\s*$/imu.test(text);
}

function chooseFiles(files) {
  if (!files.length) return;
  if (state.supportLoading || state.supporting.length) {
    showStep('review'); status('Finish the open supporting documents before adding another file.');
    $('support-heading').focus(); return;
  }
  if (files.length===1) { openRésumé(files[0]); return; }
  beginImport();
  if (files.length>maxSupportingDocuments+1) {
    status('Choose one résumé and up to five supporting files at a time.','error'); return;
  }
  const resumeName = name => /(?:résumé|resume|curriculum|(?:^|[ _.-])cv(?:[ _.-]|$)|^profile(?:[ (._-]|$)|\.vita(?:\.json)?$)/iu.test(name);
  const supportName = name => /transcript|certificat|credential|relevé|attestation/iu.test(name);
  const named = files.filter(file=>resumeName(file.name));
  const rest = files.filter(file=>!supportName(file.name));
  if (named.length===1 || (!named.length && rest.length===1)) {
    const primary=named[0] || rest[0]; openRésumé(primary,files.filter(file=>file!==primary),true); return;
  }
  if (!rest.length && files.length<=maxSupportingDocuments) {openSupporting(files);return;}
  incomingFiles=files;
  const select=$('primary-file');
  select.replaceChildren(...files.map((file,index)=>make('option',file.name,{value:String(index)})));
  if (files.length<=maxSupportingDocuments) select.append(make('option','These are all supporting documents',{value:'support'}));
  $('file-set').hidden=false; $('file-set-title').focus();
}
$('file-set-use').addEventListener('click',()=>{
  const files=incomingFiles, choice=$('primary-file').value;
  if (!files.length) return;
  $('file-set').hidden=true; incomingFiles=[];
  if (choice==='support') openSupporting(files);
  else {const index=Number(choice);openRésumé(files[index],files.filter((_,i)=>i!==index),true);}
});
$('file-set-cancel').addEventListener('click',()=>{incomingFiles=[];$('file-set').hidden=true;$('import-file').focus();});

async function openSupporting(files, prepared = new Map()) {
  if (!files.length) return;
  if (state.candidate) {
    if (extraFiles.length+files.length<=maxSupportingDocuments) {
      extraFiles.push(...files); renderCandidate(); showStep('review');
      status('These supporting files will open after you accept the résumé.');
    } else { showStep('review'); status('Review up to five supporting files per résumé.','error'); }
    return;
  }
  showStep('review');
  if (state.supportLoading) {
    supportMessage('Wait for the current documents to finish reading, then add more.');
    $('support-heading').focus();
    return;
  }
  if (state.supporting.length + files.length > maxSupportingDocuments) {
    renderSupporting(true);
    supportMessage('You can review up to five documents at once. Your current draft is unchanged.');
    $('support-heading').focus();
    return;
  }
  const run = ++state.supportRun;
  state.supportLoading = true;
  renderSupporting(true);
  $('support-heading').focus();
  for (const [index, file] of files.entries()) {
    supportMessage('Reading document ' + (index + 1) + ' of ' + files.length + '…');
    const record = {name: file.name, pages: [], notes: [], entry: emptySupportEntry(), selected: false};
    try {
      const result = prepared.get(file) || await (await documents()).importDocument(file);
      if (run !== state.supportRun) return;
      record.pages = result.pages;
      if (result.scannable && result.pages.some(page=>!page.text.trim())) record.scan = {file,result};
      record.notes = (result.warnings || []).map(warning => typeof warning === 'string' ? warning : warning?.message).filter(Boolean);
      await supportSuggestion(record);
    } catch (error) {
      record.notes.push(record.pages.length ? 'Add the facts you want to use from the original text.' : (error.message || 'This document could not be read.'));
    }
    if (run !== state.supportRun) return;
    state.supporting.push(record);
  }
  state.supportLoading = false;
  renderSupporting(true);
  supportMessage('Select an entry to add it to your résumé.');
}

function updateSupporting(event) {
  const input = event.target;
  const block = input.closest('[data-support-index]');
  if (!block) return;
  const record = state.supporting[Number(block.dataset.supportIndex)];
  if (input.hasAttribute('data-support-selected')) {
    record.selected = input.checked;
    selectSupportButton();
  } else if (input.dataset.supportField) {
    record.entry[input.dataset.supportField] = input.value;
  }
}

async function pasteSupporting(event) {
  const button = event.target.closest('button[data-support-paste]');
  if (!button) return;
  const block = button.closest('[data-support-index]');
  const index = Number(block.dataset.supportIndex);
  const record = state.supporting[index];
  const input = block.querySelector('[data-support-paste-input]');
  const text = input.value.trim();
  if (!text) {
    supportMessage('Paste document text to get a suggestion.');
    input.focus();
    return;
  }
  button.disabled = true;
  const result = {...record, pages: [{page: 1, text}], notes: []};
  try {
    await supportSuggestion(result, record.entry.section);
    if (state.supporting[index] !== record) return;
    for (const [field, value] of Object.entries(record.entry)) {
      if (value && field !== 'section') result.entry[field] = value;
    }
    result.selected = record.selected;
    result.scan = null;
    state.supporting[index] = result;
    renderSupporting(true);
    $('support-files').querySelector('[data-support-index="' + index + '"] [data-support-field="title"]').focus();
    supportMessage('Review the facts from the pasted text.');
  } catch {
    supportMessage('The text could not be read. Enter the details you want to add.');
  } finally {
    button.disabled = false;
  }
}

function closeSupporting() {
  if (scanTask?.record) closeScan();
  state.supportRun++;
  state.supportLoading = false;
  state.supporting = [];
  supportMessage();
  renderSupporting(false);
}

function applySupporting() {
  const selected = state.supporting.filter(record => record.selected);
  const empty = selected.find(record => !hasEntryContent(record.entry));
  if (empty) {
    supportMessage('Enter a detail for every selected entry, or clear its checkbox.');
    $('support-files').querySelector('[data-support-index="' + state.supporting.indexOf(empty) + '"] [data-support-field="title"]').focus();
    return;
  }
  if (!selected.length || state.supportLoading) return;
  const entries = selected.map(({entry, page}) => ({...entry, supporting: true, supportingPage: page}));
  try {
    const draft = readDraft({...state.draft, entries: [...state.draft.entries, ...entries]});
    replaceDraft(draft);
  } catch {
    supportMessage('Your draft has reached its size limit. Shorten the draft before adding more details.');
    return;
  }
  state.supporting = state.supporting.filter(record => !record.selected);
  if (state.supporting.length) {
    renderSupporting(true);
    supportMessage('You can review the remaining documents or discard this review.');
  } else closeSupporting();
  renderCandidate();
  $('review-heading').focus();
  status(entries.length === 1 ? 'Added one supporting entry.' : 'Added ' + entries.length + ' supporting entries.');
}

function renderEntries(focusIndex = null, focusField = 'title') {
  const root = $('entries');
  root.replaceChildren();
  const ordered = state.draft.entries.map((entry, index) => ({entry, index}));
  ordered.sort((a, b) => SECTIONS.indexOf(a.entry.section) - SECTIONS.indexOf(b.entry.section));
  ordered.forEach(({entry, index}, position) => {
    const number = position + 1;
    const block = make('details', '', {class:'entry entry-card', 'data-index':index});
    block.open = focusIndex === index;
    const summary = make('summary');
    const category = make('span',entry.section,{class:'entry-category'});
    const heading = make('strong',entry.title || entry.organization || entry.details.split('\n')[0] || 'New entry',{class:'entry-name'});
    summary.append(category,heading);
    const context = [entry.title ? entry.organization : '',entry.dates].filter(Boolean).join(' · ');
    if (context) summary.append(make('span',context,{class:'entry-context'}));
    block.append(summary);
    const titlebar = make('div', '', {class: 'section-head'});
    titlebar.append(make('h3', 'Edit entry'));
    const actions = make('div', '', {class: 'move-actions'});
    for (const [action, labelText, adjacent] of [
      ['up', 'Move up', ordered[position - 1]],
      ['down', 'Move down', ordered[position + 1]],
      ['remove', 'Remove', null],
    ]) {
      const button = make('button', labelText, {type: 'button', 'data-entry-action': action, 'aria-label': labelText + ' entry ' + number, class: 'text-button'});
      if (action !== 'remove') {
        button.disabled = adjacent?.entry.section !== entry.section;
        if (!button.disabled) button.dataset.targetIndex = adjacent.index;
      }
      actions.append(button);
    }
    titlebar.append(actions);
    block.append(titlebar);
    const fields = make('div', '', {class: 'fields'});
    const sectionLabel = make('label', 'Section');
    const select = make('select', '', {'data-field': 'section'});
    for (const section of SECTIONS) select.append(make('option', section, {value: section}));
    select.value = entry.section;
    sectionLabel.append(select);
    fields.append(
      sectionLabel,
      inputField('Title or qualification', 'title', entry.title, 240),
      inputField('Organization or school', 'organization', entry.organization, 240),
      inputField('Dates', 'dates', entry.dates, 160),
      inputField('Details', 'details', entry.details, MAX_SOURCE, {area: true, full: true}),
    );
    block.append(fields);
    if (entry.supporting) block.append(make('small', 'Supporting document' + (entry.supportingPage ? ' · page ' + entry.supportingPage : '')));
    else if (entry.page) block.append(make('small', 'From your file · page ' + entry.page));
    root.append(block);
  });
  attachDictation(root);
  if (!state.draft.entries.length) root.append(make('p', 'Add a job, course, project or skill.', {class:'empty-entries'}));
  if (focusIndex != null) root.querySelector('[data-index="' + focusIndex + '"] [data-field="' + focusField + '"]')?.focus();
}

function renderDraft() {
  for (const key of PROFILE) $(key).value = state.draft[key];
  $('continue-wrap').hidden = !hasContent(state.draft);
  $('remember-draft').checked = state.remember;
  updateUndo();
  renderEntries();
  const notes = $('source-notes');
  notes.replaceChildren();
  $('source-disclosure').hidden = !state.draft.sources.length;
  if (state.draft.sources.length) notes.append(sourceDetails(state.draft.sources));
  renderChecks();
}

function renderChecks() {
  const root = $('resume-checks');
  root.replaceChildren();
  const checks = checksFor(state.draft);
  if (!checks.length) { root.append(make('p','Your name, contact details and résumé content are in place.')); return; }
  for (const check of checks) {
    const control = make('button',check.label,{type:'button',class:'text-button check-link'});
    control.addEventListener('click',() => {
      if (check.index != null) renderEntries(check.index,check.target);
      else if (check.target === 'add-entry') $('add-entry').click();
      else $(check.target).focus();
    });
    root.append(control);
  }
}

function onEdit(event) {
  const input = event.target;
  const key = input.dataset.profile || input.dataset.field;
  if (!key) return;
  const block = input.closest('[data-index]');
  const item = block ? state.draft.entries[Number(block.dataset.index)] : state.draft;
  if (!item || item[key] === input.value) return;
  if (key !== 'section' && input.value.length > item[key].length &&
    draftTextSize(state.draft) + input.value.length - item[key].length > MAX_DRAFT_TEXT) {
    input.value = item[key];
    status('This draft has reached its text limit. Shorten another section to add more.', 'error');
    return;
  }
  if (editSnapshot !== input) {
    snapshot();
    editSnapshot = input;
  }
  item[key] = input.value;
  if (block && key !== 'section') {
    block.querySelector('.entry-name').textContent = item.title || item.organization || item.details.split('\n')[0] || 'New entry';
    let context = block.querySelector('.entry-context');
    const text = [item.title ? item.organization : '',item.dates].filter(Boolean).join(' · ');
    if (!context && text) { context = make('span','',{class:'entry-context'}); block.querySelector('summary').append(context); }
    if (context) context.textContent = text;
  }
  changed();
  if (key === 'section') renderEntries(Number(block.dataset.index), 'section');
}

function cancelPreview() {
  state.previewRun++;
  pdfBytes = undefined;
  pdfViewRange = undefined;
  $('pdf-zoom').hidden = true;
  setPdfZoom(false);
  $('pdf-page-nav').hidden = true;
  if (pdfViewer) {
    Promise.resolve(pdfViewer.destroy()).catch(() => {});
    pdfViewer = undefined;
  }
}

const previewBatchSize = 8;

function setPdfZoom(zoomed) {
  pdfZoomed = zoomed;
  const pages = $('pdf-pages');
  pages.classList.toggle('is-zoomed', zoomed);
  $('pdf-zoom').textContent = zoomed ? 'Fit to width' : 'Zoom in';
  $('pdf-zoom-note').hidden = !zoomed;
  for (const scroll of pages.querySelectorAll('.pdf-scroll')) {
    if (zoomed) scroll.tabIndex = 0;
    else {
      scroll.removeAttribute('tabindex');
      scroll.scrollLeft = 0;
    }
  }
}

async function renderPdfRange(first, viewer, isCurrent) {
  const pages = $('pdf-pages');
  const count = viewer.numPages;
  const last = Math.min(first + previewBatchSize - 1, count);
  pages.replaceChildren();
  $('pdf-previous').disabled = true;
  $('pdf-next').disabled = true;
  $('pdf-status').textContent = count > previewBatchSize ?
    'Pages ' + first + '–' + last + ' of ' + count : count + (count === 1 ? ' page' : ' pages');
  try {
    const preferredWidth = Math.min(1080, Math.max(832, (pages.clientWidth || 600) * 1.4));
    for (let pageNumber = first; pageNumber <= last; pageNumber++) {
      const page = await viewer.getPage(pageNumber);
      if (!isCurrent()) return;
      const figure = make('figure', '', {class: 'pdf-page'});
      figure.append(make('figcaption', 'Page ' + pageNumber + ' of ' + count));
      const scroll = make('div', '', {class: 'pdf-scroll', role: 'region', 'aria-label': 'PDF page ' + pageNumber});
      if (pdfZoomed) scroll.tabIndex = 0;
      const canvas = make('canvas', '', {role: 'img', 'aria-label': 'Page ' + pageNumber + ' of your PDF'});
      scroll.append(canvas);
      figure.append(scroll);
      pages.append(figure);
      const viewport = page.getViewport({scale: preferredWidth / page.getViewport({scale: 1}).width});
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({canvas, canvasContext: canvas.getContext('2d'), viewport}).promise;
      page.cleanup();
      if (!isCurrent()) return;
      $('pdf-zoom').hidden = false;
    }
  } finally {
    if (isCurrent()) {
      pdfViewRange = {first, viewer, isCurrent};
      $('pdf-page-nav').hidden = count <= previewBatchSize;
      $('pdf-previous').disabled = first === 1;
      $('pdf-next').disabled = last === count;
    }
  }
}

async function changePdfRange(direction) {
  if (!pdfViewRange) return;
  const {first, viewer, isCurrent} = pdfViewRange;
  const target = first + direction * previewBatchSize;
  if (target < 1 || target > viewer.numPages) return;
  try {
    await renderPdfRange(target, viewer, isCurrent);
    if (!isCurrent()) return;
    $('pdf-status').scrollIntoView({block: 'start'});
    $('pdf-status').focus({preventScroll: true});
  } catch {
    if (isCurrent()) $('pdf-status').textContent = 'These pages could not be displayed. Download the PDF to open it on this device.';
  }
}

async function preparePreview() {
  cancelPreview();
  const run = state.previewRun;
  const pages = $('pdf-pages');
  pages.replaceChildren();
  $('download-pdf').disabled = true;
  $('download-docx').disabled = !hasContent(state.draft);
  $('save-draft').disabled = !hasContent(state.draft);
  if (!hasContent(state.draft)) {
    $('pdf-status').textContent = 'Add something to your draft to create a PDF.';
    return;
  }
  $('pdf-status').textContent = 'Preparing your PDF…';
  const current = structuredClone(state.draft);
  const revision = state.revision;
  const isCurrent = () => run === state.previewRun && revision === state.revision;
  try {
    const library = await documents();
    const bytes = pdfCache?.revision===revision ? pdfCache.bytes : await library.makePdf(current);
    if (!isCurrent()) return;
    pdfCache = {revision,bytes};
    pdfBytes = bytes;
    $('download-pdf').disabled = false;
    const viewer = await library.preparePdfViewer(bytes);
    if (!isCurrent()) {
      await viewer.destroy();
      return;
    }
    pdfViewer = viewer;
    // Render exact downloadable pages and keep canvas memory bounded on long drafts.
    await renderPdfRange(1, viewer, isCurrent);
  } catch (error) {
    if (!isCurrent()) return;
    $('pdf-status').textContent = pdfBytes ?
      'Preview could not be displayed. Download the PDF to open it on this device.' :
      (error.message || 'The PDF could not be created. Return to review and try again.');
  }
}

function fileBase() {
  return state.draft.name.trim().replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\.+$/g, '').slice(0, 80) || 'Résumé';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = make('a', '', {href: url, download: name});
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

initialState();
renderDraft();
attachDictation(document);
if (draftLoadIssue) {
  status('A device draft could not be loaded. You can open a saved Vita draft or start fresh.', 'error');
}

for (const button of document.querySelectorAll('[data-step]')) {
  button.addEventListener('click', () => showStep(button.dataset.step));
}
for (const button of document.querySelectorAll('[data-go-review]')) {
  button.addEventListener('click', () => showStep('review'));
}
document.querySelector('[data-go-download]').addEventListener('click', () => showStep('download'));

$('import-file').addEventListener('change', event => {
  const files = [...event.target.files];
  event.target.value = '';
  chooseFiles(files);
});
$('draft-file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = '';
  openPortable(file);
});
for (const input of document.querySelectorAll('[data-support-upload]')) {
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    openSupporting(files);
  });
}
$('support-files').addEventListener('input', updateSupporting);
$('support-files').addEventListener('change', updateSupporting);
$('support-files').addEventListener('click', pasteSupporting);
$('apply-support').addEventListener('click', applySupporting);
$('cancel-support').addEventListener('click', () => {
  closeSupporting();
  $('review-heading').focus();
  status('Supporting document review discarded.');
});
const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, event => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}
dropzone.addEventListener('dragleave', event => {
  if (!(event.relatedTarget instanceof Node) || !dropzone.contains(event.relatedTarget)) dropzone.classList.remove('is-dragging');
});
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('is-dragging');
  chooseFiles([...event.dataTransfer.files]);
});

$('paste-start').addEventListener('click', () => openPanel('paste-panel', 'source-text'));
$('start-fresh').addEventListener('click', () => openPanel('guide-panel', 'guide-name'));
$('linkedin-start').addEventListener('click', () => openPanel('linkedin-panel', 'linkedin-url'));
$('linkedin-url').addEventListener('input', () => linkedInError());
$('linkedin-panel').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('linkedin-url');
  const link = normalizeLinkedInProfile(input.value);
  if (!link) {
    linkedInError('Enter a LinkedIn profile link such as linkedin.com/in/your-name.');
    input.focus();
    return;
  }
  const otherLinks = state.draft.website.split(/\s+\|\s+/u)
    .map(value => value.trim()).filter(value => value && !normalizeLinkedInProfile(value));
  const website = [...otherLinks, link].join(' | ');
  if (website.length > $('website').maxLength) {
    linkedInError('Your website field is full. Shorten it in Review before adding this link.');
    input.focus();
    return;
  }
  linkedInError();
  const fresh = !hasContent(state.draft);
  beginImport();
  if (website !== state.draft.website) replaceDraft({...state.draft, website});
  input.value = link;
  if (fresh) openPanel('guide-panel', 'guide-name');
  else showStep('review');
  status('LinkedIn link saved. Upload a LinkedIn PDF to bring in your experience.');
});
$('paste-panel').addEventListener('submit', event => {
  event.preventDefault();
  beginImport();
  try {
    stageSource([{page: 1, text: $('source-text').value}], 'Pasted text');
  } catch (error) {
    status(error.message, 'error');
  }
});

const guidePrompts = {
  Experience: ['Think of a task you handled, such as preparing a report, checking records, or helping a customer.', 'What did it help the team do?'],
  Education: ['Think of an assignment, experiment, presentation, or piece of research you completed.', 'What did you learn, make, or present?'],
  Projects: ['Think of a problem you helped solve, a tool you built, or an event you organized.', 'What did the project produce?'],
  Volunteering: ['Think of an event, service, or responsibility you took on for others.', 'Who did your work help?'],
  Additional: ['Think of a recurring responsibility you took on or a problem you handled.', 'How often did you do it or who did it help?'],
};

function updateGuide() {
  const [hint, question] = guidePrompts[$('guide-section').value];
  $('guide-help-hint').textContent = hint;
  $('guide-question').textContent = nextQuestion($('guide-help').value, question);
  const hidden = !$('guide-help').value.trim() && !$('guide-context').value.trim();
  $('guide-followup').hidden = hidden;
  const wrapper = document.querySelector('[data-guide-voice]'); if (wrapper) wrapper.hidden = hidden;
}

$('guide-section').addEventListener('change', updateGuide);
$('guide-help').addEventListener('input', updateGuide);
updateGuide();

$('guide-panel').addEventListener('submit', event => {
  event.preventDefault();
  beginImport();
  const linkOnly = linkedInOnly(state.draft);
  const next = linkOnly ? {...state.draft, entries: [...state.draft.entries]} : emptyDraft();
  next.name = $('guide-name').value.trim();
  const title = $('guide-title').value.trim();
  const details = [$('guide-help').value.trim(), $('guide-context').value.trim()].filter(Boolean).join('\n');
  if (title || details) {
    next.entries.push({section: $('guide-section').value, title, organization: '', dates: '', details});
  }
  if (!hasContent(next)) {
    status('Add a name, a role, or a detail to start a draft.', 'error');
    $('guide-name').focus();
    return;
  }
  if (hasContent(state.draft) && !linkOnly) stageDraft(next, 'New draft');
  else {
    replaceDraft(next);
    showStep('review');
  }
});
$('blank-start').addEventListener('click', () => {
  beginImport();
  showStep('review');
});

$('apply-import').addEventListener('click', () => {
  if (!state.candidate) return;
  replaceDraft(state.candidate.draft);
  state.candidate = null;
  closeScan();
  renderCandidate();
  $('review-heading').focus();
  const extras=extraFiles; extraFiles=[];
  if (extras.length) openSupporting(extras);
  else status('Draft updated.');
});
$('cancel-import').addEventListener('click', () => {
  state.candidate = null;
  closeScan();
  renderCandidate();
  $('review-heading').focus();
  extraFiles=[];
  status('Current draft kept.');
});

$('remember-draft').addEventListener('change', () => {
  state.remember = $('remember-draft').checked;
  persistDraft();
});
window.addEventListener('storage', event => {
  if (event.key === rememberKey && event.newValue === 'off') {
    state.remember = false;
    $('remember-draft').checked = false;
    storageConflict = false;
    $('storage-conflict').hidden = true;
    clearTimeout(savedTimer); savedTimer = undefined;
    $('save-state').textContent = 'Your draft is open for this session.';
    return;
  }
  if (!state.remember || event.key !== storageKey || event.newValue === lastStored) return;
  storageConflict = true;
  $('storage-conflict').hidden = false;
  $('save-state').textContent = 'Your edits are open in this tab.';
});
$('keep-tab').addEventListener('click', () => {
  try { lastStored = localStorage.getItem(storageKey); } catch { return; }
  storageConflict = false; $('storage-conflict').hidden = true;
  persistDraft();
});
$('use-tab').addEventListener('click', () => {
  try {
    const value = localStorage.getItem(storageKey);
    const next = value ? readDraft(JSON.parse(value).draft) : emptyDraft();
    lastStored = value; storageConflict = false; $('storage-conflict').hidden = true;
    beginImport(); closeSupporting(); replaceDraft(next); showStep('review');
  } catch { status('The other draft could not be opened. Your work is still here.', 'error'); }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && savedTimer) persistDraft();
});
window.addEventListener('pagehide', () => {
  if (savedTimer) persistDraft();
});
$('review-screen').addEventListener('input', onEdit);
$('review-screen').addEventListener('change', onEdit);
$('review-screen').addEventListener('focusout', event => {
  if (event.target === editSnapshot) editSnapshot = null;
});

$('undo').addEventListener('click', () => {
  if (!state.history.length) return;
  state.draft = state.history.pop();
  editSnapshot = null;
  changed(true);
  renderDraft();
  status('Previous draft restored.');
  if ($('undo').disabled) $('review-heading').focus();
});
$('add-entry').addEventListener('click', () => {
  if (state.draft.entries.length >= MAX_ENTRIES) {
    status('This draft already has ' + MAX_ENTRIES + ' entries.', 'error');
    return;
  }
  snapshot();
  state.draft.entries.push({section: 'Experience', title: '', organization: '', dates: '', details: ''});
  changed(true);
  renderEntries(state.draft.entries.length - 1);
});
$('entries').addEventListener('click', event => {
  const button = event.target.closest('button[data-entry-action]');
  if (!button || button.disabled) return;
  const index = Number(button.closest('[data-index]').dataset.index);
  snapshot();
  let nextIndex = index;
  if (button.dataset.entryAction === 'remove') {
    state.draft.entries.splice(index, 1);
    nextIndex = Math.min(index, state.draft.entries.length - 1);
  } else {
    nextIndex = Number(button.dataset.targetIndex);
    [state.draft.entries[index], state.draft.entries[nextIndex]] = [state.draft.entries[nextIndex], state.draft.entries[index]];
  }
  changed(true);
  renderEntries(nextIndex >= 0 ? nextIndex : null);
  if (nextIndex < 0) $('add-entry').focus();
});

$('compare-job').addEventListener('click', () => {
  const posting = $('job-posting').value.trim();
  const root = $('job-result');
  root.replaceChildren();
  if (!posting) {
    root.append(make('p', 'Paste a posting first.'));
    return;
  }
  const matches = compareTerms(posting, state.draft);
  const {matched,question}=postingEvidence(posting,state.draft);
  if (matched.length) {
    root.append(make('h3','Examples already in your résumé'));
    for (const match of matched.slice(0,4)) {
      const evidence=make('div','',{class:'job-evidence'});
      evidence.append(make('strong',match.label),make('p',match.text));
      const edit=make('button','Edit this example',{type:'button',class:'text-button'});
      edit.addEventListener('click',()=>{if(match.index>=0) renderEntries(match.index,'details');else $('summary').focus();});
      evidence.append(edit);root.append(evidence);
    }
  } else if(matches.length) root.append(make('p','Wording already in your draft: '+matches.join(', ')+'.'));
  else root.append(make('p','No shared wording found.'));
  if(question) root.append(make('p',question+' Add an example if it applies to you.',{class:'job-question'}));
});

$('download-pdf').addEventListener('click', () => {
  if (pdfBytes) download(new Blob([pdfBytes], {type: 'application/pdf'}), fileBase() + '.pdf');
});
$('pdf-status').setAttribute('tabindex', '-1');
$('pdf-zoom').addEventListener('click', () => setPdfZoom(!pdfZoomed));
$('pdf-previous').addEventListener('click', () => changePdfRange(-1));
$('pdf-next').addEventListener('click', () => changePdfRange(1));
$('download-docx').addEventListener('click', async () => {
  const button = $('download-docx');
  const revision = state.revision;
  button.disabled = true;
  try {
    const data = await (await documents()).makeDocx(structuredClone(state.draft));
    if (revision === state.revision && state.step === 'download') download(data, fileBase() + '.docx');
  } catch (error) {
    status(error.message || 'The Word file could not be created.', 'error');
  } finally {
    button.disabled = !hasContent(state.draft);
  }
});
$('save-draft').addEventListener('click', () => {
  const contents = JSON.stringify({format: 'vita', version: 1, draft: state.draft});
  download(new Blob([contents], {type: 'application/octet-stream'}), fileBase() + '.vita');
});
