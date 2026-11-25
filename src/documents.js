import {profileLayout, profileColumns} from './profile.js';
import {SECTIONS} from './draft.js';
import {readWordFields} from './word-fields.js';
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_XML_SIZE = 2 * 1024 * 1024;
const MAX_WORD_ARCHIVE_PARTS = 4_096;
const MAX_TEXT_LENGTH = 250_000;
const MAX_PAGES = 50;
const PDF_TIMEOUT = 30_000;
const LETTER = [612, 792];
const MARGIN = 48;
const WORD_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const WORD_PART = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u;

let pdfRuntime;
let fontSources;

function getPdfRuntime() {
  pdfRuntime ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  }).catch(error => {
    pdfRuntime = undefined;
    throw error;
  });
  return pdfRuntime;
}

function openPdf(pdfjs, bytes) {
  return pdfjs.getDocument({
    data: bytes,
    enableXfa: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    maxImageSize: 20_000_000,
    verbosity: 0,
  });
}

function pdfError(error) {
  if (error?.name === "PasswordException") {
    return new Error("This PDF is password protected. Save an unlocked copy or paste its text.");
  }
  return new Error("This PDF could not be read. Try another copy or paste its text.", { cause: error });
}

function waitForPdf(task, read) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("This PDF took too long to read. Try a smaller file or paste its text.")), PDF_TIMEOUT);
  });
  return Promise.race([read(task.promise), deadline]).finally(() => clearTimeout(timeout));
}

/** Open the exact generated PDF for preview without transferring the caller's buffer. */
export async function preparePdfViewer(bytes) {
  const pdfjs = await getPdfRuntime();
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  const task = openPdf(pdfjs, data);
  try {
    const document = await waitForPdf(task, promise => promise);
    return {
      numPages: document.numPages,
      getPage: number => document.getPage(number),
      destroy: () => task.destroy(),
    };
  } catch (error) {
    await task.destroy().catch(() => {});
    throw error;
  }
}

function cleanText(text) {
  return text.replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}

function requireTextLimit(length) {
  if (length > MAX_TEXT_LENGTH) {
    throw new Error("This document contains too much text to import at once. Paste the relevant sections instead.");
  }
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  if (bytes.includes(0)) throw new Error("This file does not contain plain text. Try saving a UTF-8 text file.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function groupPdfRows(items, viewport) {
  const textItems = items.filter(item => typeof item.str === "string" && item.str.trim())
    .map(item => {
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return { text: item.str, x, y, width: item.width, height: item.height };
    });
  textItems.sort((one, other) => one.y - other.y || one.x - other.x);
  const rows = [];
  for (const item of textItems) {
    const current = rows.at(-1);
    if (current && item.y - current.y <= Math.min(4, Math.max(1.5, item.height * 0.26))) {
      current.items.push(item);
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }
  for (const row of rows) row.items.sort((one, other) => one.x - other.x);
  return rows;
}

function splitPdfRow(row, pageWidth) {
  const chunks = [];
  for (const item of row) {
    const current = chunks.at(-1);
    const end = item.x + item.width;
    if (!current || item.x - current.end > Math.max(26, pageWidth * 0.053)) {
      chunks.push({ text: item.text, x: item.x, end });
      continue;
    }
    const space = item.x - current.end > Math.max(0.7, item.height * 0.12)
      && !/\s$/u.test(current.text) && !/^\s/u.test(item.text);
    current.text += (space ? " " : "") + item.text;
    current.end = Math.max(current.end, end);
  }
  return chunks;
}

function meaningfulColumnText(chunk) {
  return (chunk.text.match(/\p{L}/gu)?.length ?? 0) >= 4
    && !/^(?:[a-z]{3,9}\.?\s+)?(?:19|20)\d{2}\b/iu.test(chunk.text.trim());
}

function findColumnGutter(rows, width) {
  let best;
  for (let fraction = 0.28; fraction <= 0.68; fraction += 0.03) {
    const middle = width * fraction;
    const both = rows.flatMap(({chunks}, index) => {
      const left = chunks.some(chunk => chunk.end <= middle && meaningfulColumnText(chunk));
      const right = chunks.some(chunk => chunk.x >= middle && meaningfulColumnText(chunk));
      return left && right ? [index] : [];
    });
    if (both.length < 2) continue;
    const first = both[0];
    const last = both.at(-1);
    const crossed = rows.slice(first, last + 1)
      .filter(({chunks}) => chunks.some(chunk => chunk.x < middle - 8 && chunk.end > middle + 8)).length;
    const score = both.length * 2 - crossed * 3;
    if (score > 0 && (!best || score > best.score)) best = { middle, first, last, score };
  }
  return best;
}

function lineText(chunks) {
  return chunks.map(chunk => chunk.text.trim()).filter(Boolean).join("  ");
}

function joinPdfRows(rows) {
  const gaps = rows.slice(1).map((row, index) => row.y - rows[index].y).sort((one, other) => one - other);
  const typicalGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const paragraphGap = Math.max(18, typicalGap * 1.3);
  return rows.map(({y, text}, index) => index && y - rows[index - 1].y > paragraphGap ? `\n${text}` : text).join("\n");
}

function orderPdfRows(rows, width) {
  const line = row => ({ y: row.y, text: lineText(row.chunks) });
  const gutter = findColumnGutter(rows, width);
  if (!gutter) return { text: joinPdfRows(rows.map(line)), columns: false };
  const { middle, first, last } = gutter;
  const before = joinPdfRows(rows.slice(0, first).map(line));
  const left = [];
  const right = [];
  const ordered = [];
  function flush() {
    if (!left.length && !right.length) return;
    ordered.push(joinPdfRows(left), joinPdfRows(right));
    left.length = 0;
    right.length = 0;
  }
  for (const {y, chunks} of rows.slice(first, last + 1)) {
    if (chunks.some(chunk => chunk.x < middle - 8 && chunk.end > middle + 8)) {
      flush();
      ordered.push(lineText(chunks));
      continue;
    }
    const leftText = lineText(chunks.filter(chunk => chunk.x < middle));
    const rightText = lineText(chunks.filter(chunk => chunk.x >= middle));
    if (leftText) left.push({y, text: leftText});
    if (rightText) right.push({y, text: rightText});
  }
  flush();
  return {
    text: [before, ...ordered, joinPdfRows(rows.slice(last + 1).map(line))].filter(Boolean).join("\n"),
    columns: true,
  };
}

async function readPdf(bytes) {
  const pdfjs = await getPdfRuntime();
  const task = openPdf(pdfjs, bytes);
  try {
    return await waitForPdf(task, async promise => {
      const document = await promise.catch(error => { throw pdfError(error); });
      if (document.numPages > MAX_PAGES) {
        throw new Error(`This PDF has more than ${MAX_PAGES} pages. Choose the pages you need or paste their text.`);
      }
      const pages = [];
      const warnings = [];
      let totalLength = 0;
      let layout;
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const items = groupPdfRows(content.items, viewport);
        if (number === 1) layout = profileLayout(items, viewport.width);
        const profile = layout && profileColumns(items, viewport.width, layout, number === 1,
          line => lineText(splitPdfRow(line, viewport.width)));
        const ordered = profile ? {text: [profile.body, profile.sidebar]
          .map(column => joinPdfRows(column)).filter(Boolean).join("\n\n"), columns: false} :
          orderPdfRows(items.map(({y, items}) => ({y, chunks: splitPdfRow(items, viewport.width)})), viewport.width);
        const text = cleanText(ordered.text);
        totalLength += text.length;
        requireTextLimit(totalLength);
        pages.push({ page: number, text, ...(profile ? {profile} : {}) });
        if (!text) warnings.push(`Page ${number} has no readable text. Paste text from the original or add the missing details yourself.`);
        if (ordered.columns) warnings.push(`Page ${number} appears to use columns. Check the section order against your original.`);
        page.cleanup();
      }
      return { text: pages.map(page => page.text).filter(Boolean).join("\n\n"), pages, warnings, scannable:true };
    });
  } finally {
    await task.destroy().catch(() => {});
  }
}

function parseWordPart(bytes, expectedRoot) {
  const xml = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error("This Word file contains unsupported XML declarations.");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const root = document.documentElement;
  if (!WORD_NAMESPACES.includes(root.namespaceURI) || root.localName !== expectedRoot
    || document.getElementsByTagName("parsererror").length) {
    throw new Error("This Word file has damaged or unsupported document content.");
  }
  return root;
}

function wordParagraphs(root) {
  const paragraphs = [...root.getElementsByTagNameNS(root.namespaceURI, "p")];
  const revisionRemoves = element => element.namespaceURI === root.namespaceURI
    && (element.localName === "del" || element.localName === "moveFrom");
  return paragraphs.flatMap(paragraph => {
    for (let ancestor = paragraph.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      if (revisionRemoves(ancestor)) return [];
    }
    const text = [];
    const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT, {
      acceptNode: element => revisionRemoves(element)
        || (element.namespaceURI === root.namespaceURI && element.localName === "p")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (element.namespaceURI !== root.namespaceURI) continue;
      if (element.localName === "t") text.push(element.textContent);
      if (element.localName === "tab") text.push(" ");
      if (element.localName === "br" || element.localName === "cr") text.push("\n");
      if (element.localName === "noBreakHyphen") text.push("‑");
    }
    return [text.join("")];
  });
}

function wordArchiveWithoutComment(bytes) {
  const directory = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstPossibleRecord = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= firstPossibleRecord; index -= 1) {
    if (directory.getUint32(index, true) !== 0x06054b50) continue;
    if (index + 22 + directory.getUint16(index + 20, true) !== bytes.length) continue;
    const disk = directory.getUint16(index + 4, true);
    const directoryDisk = directory.getUint16(index + 6, true);
    const onDisk = directory.getUint16(index + 8, true);
    const total = directory.getUint16(index + 10, true);
    const size = directory.getUint32(index + 12, true);
    const offset = directory.getUint32(index + 16, true);
    const zip64 = index >= 20 && directory.getUint32(index - 20, true) === 0x07064b50;
    if (!zip64 && !disk && !directoryDisk && onDisk === total && total <= MAX_WORD_ARCHIVE_PARTS
      && size >= total * 46 && offset + size <= index) return bytes.subarray(0, index + 22);
    break;
  }
  throw new Error("The Word archive directory is damaged or exceeds the supported limits.");
}

async function readWord(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("This Word file could not be opened. Try a regular, unlocked .docx file.");
  }
  const { unzipSync } = await import("fflate");
  let files;
  let selected = 0;
  let xmlBytes = 0;
  try {
    files = unzipSync(wordArchiveWithoutComment(bytes), {
      filter: ({name, size, originalSize, compression}) => {
        if (!WORD_PART.test(name)) return false;
        if (!Number.isSafeInteger(originalSize) || originalSize < 0 || (!compression && size !== originalSize)) {
          throw new Error("Invalid Word document content size.");
        }
        selected += 1;
        xmlBytes += originalSize;
        if (selected > 40 || xmlBytes > MAX_XML_SIZE) throw new Error("Word document content limit exceeded.");
        return true;
      },
    });
  } catch (error) {
    throw new Error("This Word file is damaged or too complex to import. Try another copy or paste its text.", { cause: error });
  }
  if (!files["word/document.xml"]) throw new Error("This file does not contain a Word document.");
  const parts = Object.entries(files).sort(([first], [second]) => first.localeCompare(second, "en", { numeric: true }));
  const headers = [];
  const content = [];
  const footers = [];
  const warnings = [];
  let tagged;
  for (const [filename, data] of parts) {
    const part = filename.match(/^word\/([^\d.]+)(?:\d+)?\.xml$/u)[1];
    const names = { document: "document", header: "hdr", footer: "ftr", footnotes: "footnotes", endnotes: "endnotes" };
    const root = parseWordPart(data, names[part]);
    const paragraphs = wordParagraphs(root);
    if (part === "document") tagged = readWordFields(root);
    if (part === "header") headers.push(...paragraphs);
    else if (part === "document") content.push(...paragraphs);
    else footers.push(...paragraphs);
    if (root.getElementsByTagNameNS(root.namespaceURI, "drawing").length
      || root.getElementsByTagNameNS(root.namespaceURI, "pict").length) {
      const warning = "This Word file has images. Check the original for any text contained in pictures.";
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    if (root.getElementsByTagNameNS(root.namespaceURI, "altChunk").length
      || root.getElementsByTagNameNS(root.namespaceURI, "object").length) {
      const warning = "This Word file has embedded content. Check the original for any text inside it.";
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  const text = cleanText([...headers, ...content, ...footers].join("\n"));
  requireTextLimit(text.length);
  if (!text && !warnings.length) throw new Error("This Word file does not contain readable text.");
  if (!text) warnings.push("Paste text from the original or add the missing details yourself.");
  return { text, pages: [{ page: 1, text }], warnings, draft:tagged && ![...headers,...footers].some(line=>line.trim()) ? tagged : null };
}

/** Read a selected file into transient, page-labelled text without changing a draft. */
export async function importDocument(file) {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const photo = ["png","jpg","jpeg","webp"].includes(extension);
  if (!photo && !["pdf", "docx", "txt"].includes(extension)) {
    throw new Error("Choose a PDF, Word document, text file, or PNG, JPEG or WebP photo.");
  }
  if (!file.size) throw new Error("This file is empty.");
  if (file.size > MAX_FILE_SIZE) throw new Error("This file exceeds 20 MB. Choose a smaller copy or paste its text.");
  if (photo) {
    const head = new Uint8Array(await file.slice(0,32).arrayBuffer());
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const webp = new TextDecoder().decode(head.slice(8,12)) === 'WEBP';
    if (!(png || jpg || webp)) throw new Error('Choose a PDF, Word document, text file or readable photo. This image could not be opened.');
    return {text:'',pages:[{page:1,text:''}],warnings:[],scannable:true};
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (extension === "pdf") return readPdf(bytes);
  if (extension === "docx") return readWord(bytes);
  const text = cleanText(decodeText(bytes));
  requireTextLimit(text.length);
  if (!text) throw new Error("This file does not contain readable text.");
  return { text, pages: [{ page: 1, text }], warnings: [] };
}

function valueText(value) {
  return typeof value === "string" ? cleanText(value).normalize("NFC") : "";
}

function resumeBlocks(resume) {
  const blocks = [];
  let serial = 0, number = 0;
  const tagged = (scope,key,text) => ({tag:'Vita1_'+scope+'_'+key+'_'+(++serial),text:valueText(text)});
  const add = (kind,parts,join='') => {
    const runs = parts.filter(part=>part.text).flatMap((part,i)=>i && join ? [{text:join},part] : [part]);
    if (runs.length) blocks.push({kind,text:runs.map(run=>run.text).join(''),runs});
  };
  add('name',[tagged('header','name',resume.name)]);
  add('contact',['email','phone','location','website'].map(key=>tagged('header',key,resume[key])),' | ');
  if (valueText(resume.summary)) {
    add('heading',[tagged('label','Summary','Summary')]);
    add('body',[tagged('header','summary',resume.summary)]);
  }
  for (const section of SECTIONS) {
    const entries = (resume.entries || []).filter(entry=>entry?.section===section &&
      [entry.title,entry.organization,entry.dates,entry.details].some(value=>valueText(value)));
    if (!entries.length) continue;
    add('heading',[tagged('label',section,section==='Additional'?'Additional Information':section)]);
    for (const entry of entries) {
      const scope = 'e'+(++number)+section;
      add('entry',[tagged(scope,'title',entry.title),tagged(scope,'organization',entry.organization)],' — ');
      add('date',[tagged(scope,'dates',entry.dates)]);
      for (const detail of valueText(entry.details).split('\n')) {
        add('detail',[tagged(scope,'details',detail.trim().replace(/^(?:[•·◦▪*–—-][ \t]+)+/u,''))]);
      }
    }
  }
  const total = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (total > MAX_TEXT_LENGTH) throw new Error("This draft is too long to export. Keep the sections you need, then try again.");
  return blocks;
}

function loadFontSources() {
  fontSources ??= Promise.all([
    import("./assets/inter-regular.ttf?url"),
    import("./assets/inter-semibold.ttf?url"),
  ]).then(fonts => Promise.all(fonts.map(async font => {
    const reply = await fetch(font.default);
    if (!reply.ok) throw new Error("The PDF fonts could not be loaded. Try again or download Word.");
    return new Uint8Array(await reply.arrayBuffer());
  }))).catch(error => {
    fontSources = undefined;
    throw error;
  });
  return fontSources;
}

function wrapLine(text, font, size, width) {
  const lines = [];
  const words = text.split(/[ \t]+/u).filter(Boolean);
  let line = "";
  const fits = value => font.widthOfTextAtSize(value, size) <= width;
  for (const word of words) {
    const combined = line ? `${line} ${word}` : word;
    if (fits(combined)) {
      line = combined;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    if (fits(word)) {
      line = word;
      continue;
    }
    for (const character of word) {
      if (line && !fits(line + character)) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

const PDF_STYLES = {
  name: { size: 22, height: 28, bold: true, before: 0 },
  contact: { size: 10, height: 15, bold: false, before: 0 },
  heading: { size: 13, height: 18, bold: true, before: 12 },
  entry: { size: 11, height: 15, bold: true, before: 5 },
  date: { size: 10, height: 14, bold: false, before: 0 },
  body: { size: 10.5, height: 15, bold: false, before: 0 },
  detail: { size: 10.5, height: 15, bold: false, before: 1 },
};

function pdfRows(blocks, regular, semibold) {
  const characterSets = new Map([regular, semibold].map(font => [font, new Set(font.getCharacterSet())]));
  return blocks.map(block => {
    const style = PDF_STYLES[block.kind];
    const font = style.bold ? semibold : regular;
    const text = block.kind === "detail" ? `• ${block.text}` : block.text;
    const allowed = characterSets.get(font);
    if ([...text].some(char => !/\s/u.test(char) && !allowed.has(char.codePointAt(0)))) {
      throw new Error("The PDF font cannot display every character in this draft. Download Word to preserve the full text.");
    }
    const lines = text.split("\n").flatMap(line => wrapLine(line, font, style.size, LETTER[0] - MARGIN * 2));
    return { ...style, kind: block.kind, font, lines };
  });
}

/** Generate the single-column PDF Vita previews and downloads. */
export async function makePdf(resume) {
  const [library, fontkit, fonts] = await Promise.all([
    import("pdf-lib"), import("@pdf-lib/fontkit"), loadFontSources(),
  ]);
  const { PDFDocument, rgb } = library;
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit.default);
  document.setTitle(valueText(resume.name) ? `${valueText(resume.name)} — Résumé` : "Résumé");
  const regular = await document.embedFont(fonts[0], { subset: true });
  const semibold = await document.embedFont(fonts[1], { subset: true });
  const rows = pdfRows(resumeBlocks(resume), regular, semibold);
  const color = rgb(0.08, 0.08, 0.08);
  let page = document.addPage(LETTER);
  let cursor = LETTER[1] - MARGIN;
  function newPage() {
    page = document.addPage(LETTER);
    cursor = LETTER[1] - MARGIN;
  }
  for (const [index, row] of rows.entries()) {
    const next = rows[index + 1];
    const keepWithNext = ["heading", "entry"].includes(row.kind) && next
      ? next.before + next.height
      : 0;
    const reserved = Math.min(row.lines.length * row.height + keepWithNext, LETTER[1] - MARGIN * 2);
    if (cursor - row.before - reserved < MARGIN && cursor !== LETTER[1] - MARGIN) newPage();
    if (cursor !== LETTER[1] - MARGIN) cursor -= row.before;
    for (const line of row.lines) {
      if (cursor - row.height < MARGIN) newPage();
      if (line) page.drawText(line, { x: MARGIN, y: cursor - row.size, size: row.size, font: row.font, color });
      cursor -= row.height;
    }
  }
  return document.save();
}

/** Generate an editable Word document with the same facts and section order. */
export async function makeDocx(resume) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Bookmark } = await import("docx");
  const paragraphs = resumeBlocks(resume).map(block => {
    const bold = ["name", "heading", "entry"].includes(block.kind);
    const size = Math.round(PDF_STYLES[block.kind].size * 2);
    return new Paragraph({
      heading: block.kind === "heading" ? HeadingLevel.HEADING_1 : undefined,
      keepNext: ["name", "heading", "entry"].includes(block.kind),
      spacing: { before: PDF_STYLES[block.kind].before * 20, after: 35, line: 275 },
      children: [...(block.kind==='detail' ? [{text:'• '}] : []), ...block.runs].flatMap(run=>{
        const children=run.text.split('\n').map((part,index)=>new TextRun({text:part,break:index?1:undefined,bold,size,font:'Arial',color:'141414'}));
        return run.tag ? [new Bookmark({id:run.tag,children})] : children;
      }),
    });
  });
  const document = new Document({
    title: valueText(resume.name) ? `${valueText(resume.name)} — Résumé` : "Résumé",
    sections: [{
      properties: { page: { size: { width: 12_240, height: 15_840 }, margin: { top: 960, right: 960, bottom: 960, left: 960 } } },
      children: paragraphs,
    }],
  });
  return Packer.toBlob(document);
}
