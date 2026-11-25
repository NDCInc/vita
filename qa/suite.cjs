const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const browserLibrary = require(process.env.PLAYWRIGHT_PATH || "playwright");
const origin = new URL(process.env.VITA_URL || "http://127.0.0.1:4178/");
const suite = process.env.VITA_SUITE || "full";
const browsers = (process.env.VITA_BROWSERS || "chromium").split(",");
const deviceName = process.env.VITA_DEVICE;
const device = deviceName && browserLibrary.devices[deviceName];
const folder = path.join(__dirname, "fixtures");
const resultsFolder = path.resolve(process.env.VITA_QA_RESULTS || path.join(__dirname, "results"));
const python = process.env.VITA_QA_PYTHON || path.resolve(__dirname, "../../resume-fixtures-venv/bin/python");
const browserRequests = new WeakMap();
const sampleName = "MARA DUPONT";
const oldName = "Vita Local Recovery Marker Z9";
const linkedInProfile = "https://www.linkedin.com/in/Vita-Fictional-QA-84";
const supportFixtures = {
  transcript: "support-unofficial-transcript.pdf",
  certificate: "support-certificate.docx",
  other: "support-freeform.txt",
  unreadable: "image-only.pdf",
};
const supportPrivate = ["VITA-STUDENT-FICT-0823", "VITA-CRED-FICT-9002", "VITA-PRIVATE-OTHER-91", "2001-02-03", "3.87", "Grade: A+"];
const selectors = {
  importFile: "#import-file",
  draftFile: "#draft-file",
  importReview: "#import-review",
  applyImport: "#apply-import",
  cancelImport: "#cancel-import",
  name: "#name",
  undo: "#undo",
  preview: "#pdf-pages",
  pdf: "#download-pdf",
  docx: "#download-docx",
  portable: "#save-draft",
};

const fixture = (name) => path.isAbsolute(name) ? name : path.join(folder, name);
const normalize = (text) => text.normalize("NFC").replace(/\s+/g, " ").trim();
const step = (page, name) => page.locator(`[data-step="${name}"]`).filter({visible: true}).first();

async function switchStep(page, name) {
  await step(page, name).click();
  await page.locator(`#${name}-screen`).waitFor({state: "visible"});
}

async function currentName(page, value) {
  await page.waitForFunction(({selector, value}) => document.querySelector(selector)?.value === value, {selector: selectors.name, value});
}

async function stage(page, filename, {openSource = true} = {}) {
  await switchStep(page, "start");
  await page.locator(selectors.importFile).setInputFiles(fixture(filename));
  const panel = page.locator(selectors.importReview);
  await panel.waitFor({state: "visible"});
  if (openSource) {
    const closed = panel.locator("details:not([open]) > summary");
    const collapsed = await closed.count();
    for (let index = 0; index < collapsed; index++) await closed.first().click();
  }
  return await panel.innerText();
}

async function apply(page) {
  await page.locator(selectors.applyImport).click();
  await page.locator(selectors.name).waitFor({state: "visible"});
}

async function waitForError(page, expected) {
  await page.waitForFunction((expected) => {
    const notice = document.querySelector("#status[data-kind=error]:not([hidden])");
    return notice?.textContent.toLowerCase().includes(expected.toLowerCase());
  }, expected);
  return page.locator("#status").innerText();
}

async function download(page, selector, filename) {
  if (selector === selectors.portable && !await page.locator(selector).isVisible()) {
    await page.locator(".transfer-options > summary").click();
  }
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(selector).click(),
  ]);
  const location = path.join(resultsFolder, filename);
  await file.saveAs(location);
  return location;
}

function inspect(filename) {
  const data = execFileSync(python, [path.join(__dirname, "inspect_exports.py"), filename], {encoding: "utf8"});
  return JSON.parse(data);
}

function contains(text, values) {
  for (const value of values) assert.ok(normalize(text).includes(normalize(value)), `Missing source text: ${value}`);
}

async function activeResume(page, key) {
  return page.evaluate((name) => {
    const fields = [...document.querySelectorAll("#profile [data-profile], #entries [data-field]")];
    return fields.filter((node) => !name || node.id !== name).map((node) => node.value).join("\n");
  }, key || "");
}

async function structuredEntries(page) {
  return page.locator("#entries [data-index]").evaluateAll((entries) => entries.map((entry) =>
    Object.fromEntries([...entry.querySelectorAll("[data-field]")].map((field) => [field.dataset.field, field.value]))));
}

async function waitForPaintedPages(page, expected) {
  await page.waitForFunction(({selector, expected}) => {
    const pages = [...document.querySelectorAll(`${selector} canvas`)];
    return pages.length === expected && pages.every((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let at = 3; at < pixels.length; at += 4) if (pixels[at] > 100 && pixels[at - 3] < 230) return true;
      return false;
    });
  }, {selector: selectors.preview, expected});
}

async function verifyEnlargedLayout(page, area) {
  const textScale = await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    return {size: getComputedStyle(document.documentElement).fontSize,
      width: innerWidth, documentWidth: document.documentElement.scrollWidth};
  });
  assert.equal(textScale.size, "32px");
  assert.ok(textScale.documentWidth <= textScale.width, `${area} overflows at 200% text size: ${JSON.stringify(textScale)}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
}

async function activate(locator) {
  if (device) await locator.tap();
  else await locator.click();
}

async function openLinkedIn(page) {
  await switchStep(page, "start");
  await activate(page.locator("#linkedin-start"));
  await page.locator("#linkedin-url").waitFor({state: "visible"});
}

async function submitLinkedIn(page, url) {
  await page.locator("#linkedin-url").fill(url);
  await activate(page.locator("#linkedin-submit"));
}

function assertStaticTraffic(context, markers) {
  const requests = browserRequests.get(context);
  assert.ok(requests.length > 0);
  assert.deepEqual(requests.filter(({url, method, payload}) => url.origin !== origin.origin || !["GET", "HEAD"].includes(method)
    || markers.some(marker => decodeURIComponent(url.href).includes(marker) || payload?.includes(marker))), []);
  return requests.length;
}

async function uploadSupport(page, target, files) {
  await page.locator(`#support-file-${target}`).setInputFiles(files.map(fixture));
  await page.locator("#support-review").waitFor({state: "visible", timeout: 12000});
}

function supportCard(page, filename) {
  return page.locator("#support-files article[data-support-index]", {hasText: filename});
}

async function supportFields(card) {
  return card.locator("[data-support-field]").evaluateAll(fields => Object.fromEntries(fields.map(element =>
    [element.dataset.supportField, element.value])));
}

function excludes(text, values) {
  for (const value of values) assert.ok(!text.includes(value), `Unexpected private or unsupported text: ${value}`);
}

async function fillPasted(page, text) {
  await page.locator("#paste-start").click();
  await page.locator("#source-text").fill(text);
  await page.locator("#paste-submit").click();
  await page.locator(selectors.importReview).waitFor({state: "visible"});
}

async function importAndEdit(page, filename, editedName) {
  await stage(page, filename);
  await apply(page);
  if (editedName) await page.locator(selectors.name).fill(editedName);
}

function portableRecord(wrapper) {
  if (Array.isArray(wrapper?.entries)) return wrapper;
  for (const key of ["resume", "draft", "data"]) {
    if (Array.isArray(wrapper?.[key]?.entries)) return wrapper[key];
  }
  throw Error("Unrecognised portable draft schema");
}

function richImport(count = 75) {
  const details = Array.from({length: count}, (_, index) =>
    `Reconciled transaction batch ${index + 1} and prepared supporting working papers.`
  );
  return [
    "Zoë D’Àvila",
    "zoe@example.test",
    "+44 20 7946 0958",
    "EXPERIENCE",
    "Financial Analyst at Café & Co.",
    ...details,
    "Last-page marker 1389, reconciled supplier balances.",
    "CERTIFICATIONS",
    "CPA preparatory courses in progress",
    "VOLUNTEERING",
    "Community treasurer at Harbor Food Pantry",
  ].join("\n");
}

const tests = [
  ["clean PDF to staged draft and checked exports", async (page, engine) => {
    const source = await stage(page, "single-column.pdf");
    contains(source, [sampleName, "mara.dupont@example.org", "Tracked loan returns"]);
    await apply(page);
    await currentName(page, sampleName);
    assert.equal(await page.locator("#email").inputValue(), "mara.dupont@example.org");
    await switchStep(page, "download");
    const canvas = page.locator(`${selectors.preview} canvas`);
    await canvas.first().waitFor({state: "visible"});
    const pdfPath = await download(page, selectors.pdf, `${engine}-clean.pdf`);
    const docxPath = await download(page, selectors.docx, `${engine}-clean.docx`);
    const pdf = inspect(pdfPath);
    const word = inspect(docxPath);
    const expected = [sampleName, "Tracked loan returns", "Riverbend College"];
    contains(pdf.pages.map((entry) => entry.text).join("\n"), expected);
    contains(word.text, expected);
    await waitForPaintedPages(page, pdf.pages.length);
    assert.equal(pdf.pages.flatMap((entry) => entry.outside).length, 0);
    return {pdfHash: pdf.sha256, docxHash: word.sha256, pages: pdf.pages.length};
  }],
  ["Vita exports re-import into distinct role records with their dates", async (page, engine) => {
    await importAndEdit(page, "repeat-role.pdf");
    const expected = (await structuredEntries(page)).filter(({section}) => section === "Experience");
    assert.equal(expected.length, 3);
    assert.deepEqual(expected.slice(0, 2).map(({title}) => title), ["Financial Analyst", "Financial Analyst"]);
    assert.ok(expected.every(({title, organization, dates}) => title && organization && dates));
    await switchStep(page, "download");
    const pdfPath = await download(page, selectors.pdf, `${engine}-round-trip.pdf`);
    const wordPath = await download(page, selectors.docx, `${engine}-round-trip.docx`);
    for (const filename of [pdfPath, wordPath]) {
      await stage(page, filename);
      await apply(page);
      const reimported = (await structuredEntries(page)).filter(({section}) => section === "Experience");
      assert.deepEqual(reimported.map(({section, title, organization, dates}) => ({section, title, organization, dates})),
        expected.map(({section, title, organization, dates}) => ({section, title, organization, dates})), path.extname(filename));
      for (const [index, entry] of reimported.entries()) {
        assert.equal(entry.details.replace(/^(?:[—–•·*-]\s*)+/u, ""), expected[index].details.replace(/^(?:[—–•·*-]\s*)+/u, ""));
      }
    }
    return {roles: expected.length, formats: 2};
  }],
  ["difficult PDF content stays available in review", async (page) => {
    for (const [file, expected] of [
      ["two-columns.pdf", ["Inventory control", "Inventory Assistant", "Riverbend College", "appears to use columns"]],
      ["page-break.pdf", ["Riverbend College", "Associate of Applied Science", "Inventory control"]],
      ["international-phone.pdf", ["+44 20 7946 0958"]],
      ["additional-sections.pdf", ["First Aid Certification", "Harbour Pantry"]],
      ["french.pdf", ["Bibliothèque", "Diplôme en logistique"]],
      ["mixed-scan.pdf", ["MARA DUPONT", "Page 2 has no readable text"]],
    ]) {
      const source = await stage(page, file);
      contains(source, expected);
      await page.locator(selectors.cancelImport).click();
    }
    return {fixtures: 6};
  }],
  ["multiple roles and page-break continuations stay identifiable", async (page) => {
    await importAndEdit(page, "multiple-roles.pdf");
    const experience = (await structuredEntries(page)).filter(({section}) => section === "Experience");
    assert.deepEqual(experience.map(({title}) => title), ["Senior Financial Analyst", "Accounting Clerk", "Bookkeeper"]);
    contains(experience[0].details, ["Prepared business forecasts"]);
    contains(experience[1].details, ["Reconciled supplier payments"]);
    contains(experience[2].details, ["Tracked monthly accruals"]);
    const stageText = await stage(page, "role-continues.pdf");
    contains(stageText, ["Owned monthly budget reporting", "Bachelor of Commerce"]);
    assert.match(stageText, /check whether the first bullet on page 2 belongs to an entry on the previous page/i);
    await apply(page);
    assert.match(await activeResume(page), /Owned monthly budget reporting/);
    return {roles: 3, continuationFlagged: true};
  }],
  ["structured placement preserves original problem cases", async (page) => {
    for (const [file, expectations] of [
      ["two-columns.pdf", {Experience: ["Inventory Assistant", "Alder Library Co."]}],
      ["page-break.pdf", {Experience: ["Inventory Assistant"], Education: ["Riverbend College", "Associate of Applied Science"], Skills: ["Inventory control"]}],
      ["additional-sections.pdf", {Certifications: ["First Aid Certification"], Volunteering: ["Harbour Pantry"]}],
      ["french.pdf", {Experience: ["Bibliothèque", "Adjointe"], Education: ["Collège", "Diplôme en logistique"]}],
    ]) {
      await importAndEdit(page, file);
      const entries = await structuredEntries(page);
      for (const [section, expected] of Object.entries(expectations)) {
        const found = entries.filter((entry) => entry.section === section).map((entry) => Object.values(entry).join(" ")).join("\n");
        for (const phrase of expected) assert.ok(normalize(found).includes(phrase), `${file}: ${phrase} missing from ${section}`);
      }
    }
    await importAndEdit(page, "international-phone.pdf");
    assert.equal(await page.locator("#phone").inputValue(), "+44 20 7946 0958");
    assert.ok(!(await page.locator("#summary").inputValue()).includes("+44 20 7946 0958"));
    return {fixtures: 5};
  }],
  ["Word header, table and accented text survive staging", async (page) => {
    const source = await stage(page, "header-and-table.docx");
    contains(source, ["Émilie O’Connor", "emilie@example.test", "Cédar Partners", "Reconciled supplier invoices"]);
    await apply(page);
    await currentName(page, "Émilie O’Connor");
    assert.equal(await page.locator("#email").inputValue(), "emilie@example.test");
    const finance = await stage(page, "finance.docx");
    contains(finance, ["CPA preparatory courses", "Community treasurer", "+44 20 7946 0958"]);
    await apply(page);
    await currentName(page, "Émilie O’Connor");
    assert.match(await activeResume(page, "name"), /CPA preparatory courses/);
    return {fixtures: 2};
  }],
  ["bad files preserve the previously saved draft", async (page) => {
    await importAndEdit(page, "single-column.pdf", oldName);
    await switchStep(page, "start");
    for (const [file, expected] of [
      ["image-only.pdf", "no readable text"], ["corrupt.pdf", "PDF could not be read"], ["protected.pdf", "password protected"],
      ["corrupt.docx", "Word file could not be opened"], ["empty.docx", "Word file does not contain readable text"],
      ["empty.txt", "file does not contain readable text"], ["wrong-type.png", "Choose a PDF"],
    ]) {
      await page.locator(selectors.importFile).setInputFiles(fixture(file));
      assert.match(await waitForError(page, expected), /current draft is unchanged/i);
      assert.ok(await page.locator("#paste-panel").isVisible(), `No paste recovery for ${file}`);
      assert.ok(!await page.locator(selectors.applyImport).isVisible(), `Unexpected apply action for ${file}`);
    }
    await page.reload();
    await switchStep(page, "review");
    await currentName(page, oldName);
    return {fixtures: 7};
  }],
  ["a failed import supersedes an unapplied candidate", async (page) => {
    await importAndEdit(page, "single-column.pdf", oldName);
    await stage(page, "finance.docx");
    await switchStep(page, "start");
    await page.locator(selectors.importFile).setInputFiles(fixture("corrupt.pdf"));
    await waitForError(page, "PDF could not be read");
    await switchStep(page, "review");
    await currentName(page, oldName);
    assert.equal(await page.locator(selectors.applyImport).isVisible(), false);
  }],
  ["cancel, apply, undo and reload preserve draft history", async (page) => {
    await importAndEdit(page, "single-column.pdf", oldName);
    await switchStep(page, "start");
    await stage(page, "finance.docx");
    await page.locator(selectors.cancelImport).click();
    await switchStep(page, "review");
    await currentName(page, oldName);
    await switchStep(page, "start");
    await importAndEdit(page, "finance.docx");
    await currentName(page, "Émilie O’Connor");
    await page.locator(selectors.undo).click();
    await currentName(page, oldName);
    await page.reload();
    await switchStep(page, "review");
    await currentName(page, oldName);
  }],
  ["portable draft round-trips and bad draft JSON changes nothing", async (page, engine, context) => {
    await importAndEdit(page, "finance.docx");
    await switchStep(page, "download");
    const filename = await download(page, selectors.portable, `${engine}-portable.json`);
    const expected = portableRecord(JSON.parse(await fs.readFile(filename, "utf8")));
    assert.equal(expected.name, "Émilie O’Connor");
    const otherContext = await context.browser().newContext();
    try {
      const other = await otherContext.newPage();
      await other.goto(origin.href);
      await other.locator(selectors.draftFile).setInputFiles(filename);
      await other.locator(selectors.applyImport).waitFor({state: "visible"});
      await apply(other);
      await currentName(other, expected.name);
      for (const filename of ["malformed.json", "unsupported.json"]) {
        await switchStep(other, "start");
        await other.locator(selectors.draftFile).setInputFiles(fixture(filename));
        await waitForError(other, filename === "malformed.json" ? "readable Vita draft" : "supported Vita draft");
        assert.ok(!await other.locator(selectors.applyImport).isVisible());
        await switchStep(other, "review");
        await currentName(other, expected.name);
      }
    } finally {
      await otherContext.close();
    }
  }],
  ["all pages previewed and present as selectable PDF text", async (page, engine) => {
    await page.evaluate(() => {
      window.__qaPreviewBytes = [];
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...options) {
        if (message?.action === "GetDocRequest" && message?.data?.data instanceof Uint8Array) {
          window.__qaPreviewBytes.push(Array.from(message.data.data));
        }
        return postMessage.call(this, message, ...options);
      };
    });
    await fillPasted(page, richImport());
    await apply(page);
    await currentName(page, "Zoë D’Àvila");
    await switchStep(page, "download");
    const preview = page.locator(`${selectors.preview} canvas`);
    await preview.first().waitFor({state: "visible"});
    const filename = await download(page, selectors.pdf, `${engine}-long.pdf`);
    const document = inspect(filename);
    assert.ok(document.pages.length >= 2);
    await waitForPaintedPages(page, document.pages.length);
    assert.equal(document.pages.flatMap((item) => item.outside).length, 0);
    assert.ok(document.pages.every((item) => item.words > 0));
    const complete = document.pages.map((item) => item.text).join("\n");
    contains(complete, ["Zoë D’Àvila", "Last-page marker 1389", "Harbor Food Pantry", "CPA preparatory courses"]);
    assert.match(document.pages.at(-1).text, /CPA preparatory courses/);
    const previewBytes = await page.evaluate(() => window.__qaPreviewBytes.at(-1));
    assert.ok(previewBytes?.length, "Could not observe the preview PDF passed to its worker");
    const previewHash = createHash("sha256").update(Buffer.from(previewBytes)).digest("hex");
    assert.equal(previewHash, document.sha256, "The PDF download differs from the bytes rendered in the preview");
    return {pages: document.pages.length, hash: document.sha256, exactPreviewBytes: true};
  }],
  ["long preview pages can be viewed past the first eight", async (page, engine) => {
    await fillPasted(page, richImport(388));
    await apply(page);
    await switchStep(page, "download");
    await page.locator("#pdf-next").waitFor({state: "visible", timeout: 12000});
    await waitForPaintedPages(page, 8);
    const filename = await download(page, selectors.pdf, `${engine}-long-batches.pdf`);
    const inspection = inspect(filename);
    assert.ok(inspection.pages.length > 8);
    await page.locator("#pdf-next").click();
    await waitForPaintedPages(page, inspection.pages.length - 8);
    assert.match(await page.locator(`${selectors.preview} figcaption`).first().innerText(), /Page 9/);
    assert.match(inspection.pages.at(-1).text, /CPA preparatory courses/);
    await page.locator("#pdf-previous").click();
    await waitForPaintedPages(page, 8);
    assert.match(await page.locator(`${selectors.preview} figcaption`).first().innerText(), /Page 1/);
    return {pages: inspection.pages.length};
  }],
  ["Unicode plain text import and source evidence", async (page) => {
    const source = await stage(page, "unicode.txt");
    contains(source, ["Zoë D’Àvila", "zoe@example.test", "Analyzed 14 budgets at Café & Co."]);
    await apply(page);
    assert.match(await activeResume(page), /Zoë D’Àvila/);
    assert.equal(await page.locator("#email").inputValue(), "zoe@example.test");
  }],
  ["guided setup asks for evidence and avoids inventing job matches", async (page) => {
    await openLinkedIn(page);
    await page.locator(".linkedin summary").click();
    await page.getByText("Save to PDF", {exact: true}).waitFor({state: "visible"});
    await page.locator("#start-fresh").click();
    await page.locator("#guide-submit").click();
    assert.equal(await page.locator("#guide-panel").isVisible(), true);
    await page.locator("#guide-name").fill("Devon Fields");
    await page.locator("#guide-section").selectOption("Volunteering");
    assert.equal(await page.locator("#guide-followup").isVisible(), false);
    await page.locator("#guide-title").fill("Treasurer");
    await page.locator("#guide-help").fill("Reconciled donations and bank deposits.");
    await page.locator("#guide-followup").waitFor({state: "visible"});
    assert.ok((await page.locator("#guide-question").innerText()).trim());
    await page.locator("#guide-context").fill("Prepared quarterly folders for the board.");
    await page.locator("#guide-submit").click();
    await page.locator("#review-screen").waitFor({state: "visible"});
    await currentName(page, "Devon Fields");
    const [entry] = await structuredEntries(page);
    assert.equal(entry.section, "Volunteering");
    assert.equal(entry.title, "Treasurer");
    assert.equal(entry.details, "Reconciled donations and bank deposits.\nPrepared quarterly folders for the board.");
    await page.locator("details summary", {hasText: "Compare a job posting"}).click();
    await page.locator("#job-posting").fill("Prepared reconciled reports and CPA certification verification.");
    await page.locator("#compare-job").click();
    const result = await page.locator("#job-result").innerText();
    assert.match(result, /reconciled/i);
    assert.doesNotMatch(result, /certification|CPA/i);
    assert.deepEqual(await structuredEntries(page), [entry]);
  }],
  ["LinkedIn intake starts a local guided draft and exports the profile link", async (page, engine, context) => {
    const label = (deviceName || engine).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await openLinkedIn(page);
    if (device) await verifyEnlargedLayout(page, "LinkedIn intake");
    await submitLinkedIn(page, "https://ca.linkedin.com/in/Vita-Fictional-QA-84/?trk=private-test-marker#profile");
    const guide = page.locator("#guide-name");
    await guide.waitFor({state: "visible"});
    assert.equal(await guide.inputValue(), "");
    assert.equal(await guide.evaluate(element => element === document.activeElement), true);
    await guide.fill("Morgan Example");
    await page.locator("#guide-section").selectOption("Projects");
    await page.locator("#guide-title").fill("Financial projection model");
    await page.locator("#guide-help").fill("Calculated year-over-year costs with a spreadsheet.");
    await activate(page.locator("#guide-submit"));
    await page.locator("#review-screen").waitFor({state: "visible"});
    await currentName(page, "Morgan Example");
    assert.equal(await page.locator("#website").inputValue(), linkedInProfile);
    assert.equal(await page.locator("#email").inputValue(), "");
    assert.equal((await structuredEntries(page)).length, 1);
    await switchStep(page, "download");
    const filename = await download(page, selectors.portable, `${label}-linkedin.json`);
    const saved = portableRecord(JSON.parse(await fs.readFile(filename, "utf8")));
    assert.equal(saved.website, linkedInProfile);
    const pdf = await download(page, selectors.pdf, `${label}-linkedin.pdf`);
    contains(inspect(pdf).pages.map(({text}) => text).join(" "), [linkedInProfile, "Financial projection model"]);
    const requests = assertStaticTraffic(context, ["Vita-Fictional-QA-84", "private-test-marker"]);
    return {normalizedLinkExported: true, noProfileRequests: true, staticRequests: requests, device: deviceName};
  }],
  ["LinkedIn intake rejects unrelated links and preserves edits and undo", async (page, _engine, context) => {
    await importAndEdit(page, "single-column.pdf", oldName);
    const originalWebsite = await page.locator("#website").inputValue();
    assert.ok(originalWebsite);
    const beforeEntries = await structuredEntries(page);
    await openLinkedIn(page);
    const invalid = [
      "https://www.linkedin.com.example.test/in/Vita-Fictional-QA-84/",
      "https://www.linkedin.com/company/Vita-Fictional-QA-84/",
      "https://example.test@www.linkedin.com/in/Vita-Fictional-QA-84/",
      "https://www.linkedin.com/in/Vita-Fictional-QA-84%2Fextra/",
    ];
    for (const url of invalid) {
      await submitLinkedIn(page, url);
      const error = page.locator("#linkedin-panel #linkedin-error[role=alert]");
      await error.waitFor({state: "visible"});
      assert.match(await error.innerText(), /LinkedIn profile/i);
      const input = page.locator("#linkedin-url");
      assert.equal(await input.getAttribute("aria-invalid"), "true");
      assert.ok((await input.getAttribute("aria-describedby")).split(/\s+/).includes("linkedin-error"));
      assert.equal(await page.locator("#linkedin-panel").isVisible(), true);
      assert.equal(await page.locator("#website").inputValue(), originalWebsite);
      assert.deepEqual(await structuredEntries(page), beforeEntries);
    }
    await submitLinkedIn(page, "www.linkedin.com/in/Vita-Fictional-QA-84/?trk=private-test-marker");
    await page.locator("#review-screen").waitFor({state: "visible"});
    assert.equal(await page.locator("#website").inputValue(), `${originalWebsite} | ${linkedInProfile}`);
    await currentName(page, oldName);
    assert.deepEqual(await structuredEntries(page), beforeEntries);
    await activate(page.locator(selectors.undo));
    assert.equal(await page.locator("#website").inputValue(), originalWebsite);
    await page.reload();
    await switchStep(page, "review");
    await currentName(page, oldName);
    assert.equal(await page.locator("#website").inputValue(), originalWebsite);
    assert.deepEqual(await structuredEntries(page), beforeEntries);
    assertStaticTraffic(context, ["Vita-Fictional-QA-84", "private-test-marker"]);
    return {rejectedLinks: invalid.length, restoredOriginalWebsite: true, device: deviceName};
  }],
  ["LinkedIn intake keeps the user link through file import and the two-link export round trip", async (page, engine, context) => {
    const label = (deviceName || engine).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const personalSite = "https://example.test/mara";
    await openLinkedIn(page);
    await submitLinkedIn(page, linkedInProfile);
    await page.locator("#guide-panel").waitFor({state: "visible"});
    await stage(page, "french.pdf", {openSource: false});
    await apply(page);
    await currentName(page, sampleName);
    assert.equal(await page.locator("#website").inputValue(), linkedInProfile);
    const website = `${personalSite} | ${linkedInProfile}`;
    await page.locator("#website").fill(website);
    await switchStep(page, "download");
    const pdf = await download(page, selectors.pdf, `${label}-linkedin-dual.pdf`);
    const word = await download(page, selectors.docx, `${label}-linkedin-dual.docx`);
    for (const filename of [pdf, word]) {
      await stage(page, filename, {openSource: false});
      await apply(page);
      assert.equal(await page.locator("#website").inputValue(), website, path.extname(filename));
    }
    assertStaticTraffic(context, ["Vita-Fictional-QA-84"]);
    return {retainedDuringImport: true, reimportedFormats: 2, device: deviceName};
  }],
  ["Supporting docs add only confirmed facts and preserve the résumé through undo", async (page, engine, context) => {
    const label = (deviceName || engine).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await importAndEdit(page, "single-column.pdf", oldName);
    const originalEmail = await page.locator("#email").inputValue();
    const originalEntries = await structuredEntries(page);
    await uploadSupport(page, "review", Object.values(supportFixtures));
    const transcript = supportCard(page, supportFixtures.transcript);
    const certificate = supportCard(page, supportFixtures.certificate);
    const note = supportCard(page, supportFixtures.other);
    const unreadable = supportCard(page, supportFixtures.unreadable);
    for (const card of [transcript, certificate, note, unreadable]) await card.waitFor({state: "visible"});
    await activate(transcript.locator("details summary").first());
    contains(await transcript.innerText(), ["VITA-STUDENT-FICT-0823", "Cumulative GPA: 3.87"]);
    if (device) await verifyEnlargedLayout(page, "Supporting documents review");
    assert.match(await unreadable.innerText(), /no readable|could not|unreadable|scan/i);
    assert.equal(await page.locator("#apply-support").isEnabled(), false);
    for (const checkbox of await page.locator("#support-files input[data-support-selected]").all()) {
      assert.equal(await checkbox.isChecked(), false);
    }
    const academic = await supportFields(transcript);
    assert.equal(academic.section, "Education");
    contains(JSON.stringify(academic), ["Bachelor of Commerce", "Stonewater College", "In progress"]);
    excludes(JSON.stringify(academic), [...supportPrivate, "Degree awarded", "FIN 313", "2026-04-30"]);
    assert.equal(academic.dates, "");
    assert.doesNotMatch([academic.title, academic.details].join(" "), /graduated|degree awarded|degree completed/i);
    const credential = await supportFields(certificate);
    assert.equal(credential.section, "Certifications");
    contains(JSON.stringify(credential), ["Financial Modelling Foundations", "North Bridge Learning Institute"]);
    excludes(JSON.stringify(credential), supportPrivate);
    const other = await supportFields(note);
    assert.deepEqual([other.title, other.organization, other.dates, other.details], ["", "", "", ""]);
    excludes(await page.evaluate(() => JSON.stringify(localStorage)), supportPrivate);
    assert.deepEqual(await structuredEntries(page), originalEntries);

    assert.equal(other.section, "Additional");
    await note.locator('[data-support-field="title"]').fill("Neighbourhood budget exercise");
    await note.locator('[data-support-field="details"]').fill("Compared expenses in a spreadsheet.");
    for (const card of [transcript, certificate, note]) await activate(card.locator("input[data-support-selected]"));
    await activate(page.locator("#apply-support"));
    await transcript.waitFor({state: "hidden"});
    assert.equal(await unreadable.isVisible(), true);
    await activate(page.locator("#cancel-support"));
    await page.locator("#support-review").waitFor({state: "hidden"});
    await currentName(page, oldName);
    assert.equal(await page.locator("#email").inputValue(), originalEmail);
    const updated = await structuredEntries(page);
    assert.deepEqual(updated.filter(entry => originalEntries.some(original => JSON.stringify(entry) === JSON.stringify(original))), originalEntries);
    assert.equal(updated.length, originalEntries.length + 3);
    const accepted = ["Bachelor of Commerce", "Stonewater College", "Financial Modelling Foundations", "North Bridge Learning Institute", "Neighbourhood budget exercise"];
    contains(JSON.stringify(updated), accepted);
    excludes(JSON.stringify(updated), supportPrivate);
    await switchStep(page, "download");
    const portable = await download(page, selectors.portable, `${label}-support.json`);
    const saved = await fs.readFile(portable, "utf8");
    contains(saved, accepted);
    excludes(saved, [...supportPrivate, ...Object.values(supportFixtures), "PROJECT FIELD NOTES", "UNOFFICIAL ACADEMIC TRANSCRIPT"]);
    const files = [
      await download(page, selectors.pdf, `${label}-support.pdf`),
      await download(page, selectors.docx, `${label}-support.docx`),
    ];
    for (const filename of files) {
      const artifact = inspect(filename);
      const text = artifact.text || artifact.pages.map(page => page.text).join("\n");
      contains(text, [oldName, ...accepted]);
      excludes(text, supportPrivate);
    }
    await page.reload();
    await switchStep(page, "review");
    assert.deepEqual(await structuredEntries(page), updated);
    await activate(page.locator(selectors.undo));
    assert.deepEqual(await structuredEntries(page), originalEntries);
    await currentName(page, oldName);
    assertStaticTraffic(context, supportPrivate);
    return {confirmedFacts: 3, oneUndo: true, scannedFilePreservedOtherCandidates: true, device: deviceName};
  }],
  ["Supporting docs can be dismissed from a fresh draft without saving their contents", async (page, _engine, context) => {
    await uploadSupport(page, "start", [supportFixtures.other, supportFixtures.unreadable]);
    const note = supportCard(page, supportFixtures.other);
    await note.waitFor({state: "visible"});
    await note.locator('[data-support-field="title"]').fill("Discarded manual note");
    await activate(note.locator("input[data-support-selected]"));
    await activate(page.locator("#cancel-support"));
    await page.locator("#support-review").waitFor({state: "hidden"});
    await page.reload();
    await switchStep(page, "review");
    await currentName(page, "");
    assert.deepEqual(await structuredEntries(page), []);
    excludes(await page.evaluate(() => JSON.stringify(localStorage)), [...supportPrivate, "Discarded manual note"]);
    assertStaticTraffic(context, supportPrivate);
    return {cancelledFromFreshDraft: true, device: deviceName};
  }],
  ["Supporting docs recover an image-only scan through local pasted text", async (page, _engine, context) => {
    await uploadSupport(page, "start", [supportFixtures.unreadable]);
    const scan = supportCard(page, supportFixtures.unreadable);
    await scan.waitFor({state: "visible"});
    await scan.locator('[data-support-field="section"]').selectOption("Education");
    await activate(scan.getByText("Paste text from this document", {exact: true}));
    const marker = "VITA-PASTED-ACADEMIC-73";
    await scan.locator("[data-support-paste-input]").fill([
      "UNOFFICIAL ACADEMIC TRANSCRIPT", "Program: Diploma in Accounting", "Institution: Stonewater College",
      "Program status: In progress", `Student ID: ${marker}`, "Cumulative GPA: 3.87",
    ].join("\n"));
    await activate(scan.locator("[data-support-paste]"));
    await page.waitForFunction(() => document.querySelector('[data-support-field="title"]')?.value === 'Diploma in Accounting');
    const academic = await supportFields(scan);
    assert.equal(academic.organization, "Stonewater College");
    assert.equal(academic.details, "In progress");
    excludes(JSON.stringify(academic), [marker, "3.87"]);
    await activate(scan.locator("input[data-support-selected]"));
    await activate(page.locator("#apply-support"));
    await page.locator("#support-review").waitFor({state: "hidden"});
    assert.equal((await structuredEntries(page)).length, 1);
    excludes(await page.evaluate(() => JSON.stringify(localStorage)), [marker, "3.87"]);
    assertStaticTraffic(context, [marker]);
    return {pastedScanTextUsed: true, device: deviceName};
  }],
  ["device save off keeps current session and clears persistent state", async (page) => {
    await importAndEdit(page, "finance.docx", oldName);
    await page.locator("#remember-draft").uncheck();
    await currentName(page, oldName);
    assert.equal(await page.evaluate(() => localStorage.getItem("vita:draft:v1")), null);
    await page.reload();
    await switchStep(page, "review");
    await currentName(page, "");
    assert.equal(await page.locator("#remember-draft").isChecked(), false);
  }],
  ["narrow viewport and keyboard navigation", async (page, engine) => {
    await page.keyboard.press("Tab");
    if (engine === "webkit" && await page.evaluate(() => document.activeElement === document.body)) {
      // Safari's default link navigation uses Option-Tab.
      await page.keyboard.press("Alt+Tab");
    }
    const focus = await page.evaluate(() => ({
      element: document.activeElement?.tagName,
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.ok(["A", "BUTTON", "INPUT", "SUMMARY"].includes(focus.element), `Unexpected focus: ${focus.element}`);
    assert.ok(focus.width <= focus.viewport, JSON.stringify(focus));
    await importAndEdit(page, "single-column.pdf");
    await page.locator(selectors.name).focus();
    assert.ok(await page.locator(selectors.name).evaluate((node) => node === document.activeElement));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
  }],
  ["resume details never traverse the network", async (page, engine, context) => {
    const marker = "Private Local Marker K7";
    await fillPasted(page, `${marker}\nprivacy@example.test\nEXPERIENCE\nPrepared 11 recurring finance reports.`);
    await apply(page);
    await page.locator(selectors.name).fill(marker);
    await currentName(page, marker);
    await switchStep(page, "download");
    await download(page, selectors.pdf, `${engine}-private.pdf`);
    await download(page, selectors.docx, `${engine}-private.docx`);
    const requests = browserRequests.get(context);
    assert.ok(requests.length > 0);
    assert.deepEqual(requests.filter(({url, method, payload}) =>
      url.origin !== origin.origin || !["GET", "HEAD"].includes(method)
      || decodeURIComponent(url.href).includes(marker) || payload?.includes(marker)), []);
    return {sameOriginStaticRequests: requests.length};
  }],
  ["touch profile reflows, scrolls and downloads at phone or tablet size", async (page, engine) => {
    const label = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const initial = await page.evaluate(() => ({
      viewport: document.querySelector('meta[name="viewport"]').content,
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      touch: "ontouchstart" in window,
      coarsePointer: matchMedia("(pointer: coarse)").matches,
    }));
    assert.ok(initial.touch && initial.coarsePointer);
    assert.ok(initial.documentWidth <= initial.width);
    assert.doesNotMatch(initial.viewport, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/i);
    await page.locator("#start-fresh").tap();
    await page.locator("#guide-title").waitFor({state: "visible"});
    await verifyEnlargedLayout(page, "Guided start");
    await page.locator(selectors.importFile).setInputFiles(fixture("page-break.pdf"));
    await page.locator(selectors.importReview).waitFor({state: "visible"});
    await page.locator(selectors.applyImport).tap();
    await currentName(page, sampleName);
    await verifyEnlargedLayout(page, "Review");
    await page.locator("#add-entry").scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => scrollY > 0));
    await page.locator("#add-entry").tap();
    const added = page.locator('#entries [data-index][open] [data-field="title"]').first();
    await added.fill("Operations check");
    await page.locator("#review-screen [data-go-download]").tap();
    const canvas = page.locator(`${selectors.preview} canvas`);
    await canvas.first().waitFor({state: "visible", timeout: 12000});
    const pdfName = await download(page, selectors.pdf, `${engine}-${label}.pdf`);
    const wordName = await download(page, selectors.docx, `${engine}-${label}.docx`);
    const pdfData = inspect(pdfName);
    await waitForPaintedPages(page, pdfData.pages.length);
    await verifyEnlargedLayout(page, "Download");
    contains(pdfData.pages.map(({text}) => text).join(" "), [sampleName, "Operations check"]);
    contains(inspect(wordName).text, [sampleName, "Operations check"]);
    await canvas.last().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    return {device: deviceName, viewport: page.viewportSize(), touch: true, enlargedText: "200%", nativePinch: "unverified"};
  }],
  ["warm PDF import timing against two-second target", async (page) => {
    const runs = [];
    for (let iteration = 0; iteration < 13; iteration++) {
      const started = performance.now();
      await stage(page, "page-break.pdf", {openSource: false});
      if (iteration > 0) runs.push(performance.now() - started);
      await page.locator(selectors.cancelImport).click();
    }
    runs.sort((a, b) => a - b);
    const p95 = runs[Math.ceil(0.95 * runs.length) - 1];
    assert.ok(p95 <= 2000, `warm desktop P95 was ${Math.round(p95)} ms`);
    return {runs: runs.length, p95Ms: Math.round(p95), withinTarget: p95 <= 2000, environment: "desktop emulation only"};
  }],
];

async function run() {
  if (deviceName && !device) throw new Error(`Unknown Playwright device profile: ${deviceName}`);
  await fs.mkdir(resultsFolder, {recursive: true});
  let failed = 0;
  const reports = [];
  const smoke = /clean PDF|structured placement|previously saved|draft history|keyboard navigation|traverse the network|guided setup/;
  const pattern = process.env.VITA_CASE && new RegExp(process.env.VITA_CASE, "i");
  for (const engine of browsers) {
    const executablePath = process.env[`VITA_${engine.toUpperCase()}_EXECUTABLE`];
    const channel = engine === "chromium" ? process.env.VITA_CHROME_CHANNEL : undefined;
    const browser = await browserLibrary[engine].launch({executablePath, channel});
    try {
      for (const [index, [name, task]] of tests.entries()) {
        const touchCase = name.startsWith("touch profile");
        if ((suite === "smoke" && !smoke.test(name)) || (suite === "mobile" && !touchCase)
          || (touchCase && !device) || (pattern && !pattern.test(name))) continue;
        const viewport = name === "narrow viewport and keyboard navigation" ? {width:320,height:750} : {width:1240,height:850};
        const context = await browser.newContext({acceptDownloads: true, viewport, ...device});
        const requests = [];
        browserRequests.set(context, requests);
        context.on("request", (request) => {
          const url = new URL(request.url());
          if (["http:", "https:"].includes(url.protocol)) requests.push({url, method: request.method(), payload: request.postData()});
        });
        const page = await context.newPage();
        page.setDefaultTimeout(4500);
        const rejections = [];
        page.on("pageerror", (error) => rejections.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error" && !/404|403/.test(message.text())) rejections.push(`Console: ${message.text()}`);
        });
        const started = performance.now();
        try {
          const response = await page.goto(origin.href, {waitUntil: "domcontentloaded", timeout: 10000});
          assert.equal(response.status(), 200);
          await page.waitForFunction(() => !!document.querySelector("#entries > *"));
          assert.match(await page.title(), /Vita/);
          await page.locator("#start-heading").waitFor({state: "visible"});
          assert.equal(await page.locator("vite-error-overlay").count(), 0);
          const details = await task(page, engine, context);
          assert.deepEqual(rejections, []);
          reports.push({test: name, engine, status: "pass", ms: Math.round(performance.now() - started), ...(details || {})});
          console.log(`PASS [${engine}] ${name}${details ? " " + JSON.stringify(details) : ""}`);
        } catch (error) {
          failed++;
          reports.push({test: name, engine, status: "fail", error: error.message, rejections});
          console.log(`FAIL [${engine}] ${name}: ${error.message.split("\n")[0]}${rejections.length ? " " + JSON.stringify(rejections) : ""}`);
          await page.screenshot({path: path.join(resultsFolder, `${engine}-failure-${index}.png`), fullPage: true, timeout: 2500}).catch(() => {});
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  const label = process.env.VITA_REPORT_LABEL || browsers.join("-");
  await fs.writeFile(path.join(resultsFolder, `report-${label}.json`), JSON.stringify({origin: origin.origin, results: reports}, null, 2));
  console.log(`${reports.length - failed}/${reports.length} tests passed`);
  process.exitCode = Number(failed > 0);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
