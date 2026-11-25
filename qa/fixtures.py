"""Generate fictional, deterministic-content fixtures for Vita's public file types."""

from html import escape
from pathlib import Path
from shutil import copyfile
from zipfile import ZIP_DEFLATED, ZipFile
import json

import pymupdf as pdf


HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "fixtures"
OUTPUT.mkdir(exist_ok=True)
BASELINE = HERE.parent.parent / "open-resume-fixtures"


def paragraph(value: str) -> str:
    return f"<w:p><w:r><w:t>{escape(value)}</w:t></w:r></w:p>"


def make_word(filename, content, header=None):
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package = "http://schemas.openxmlformats.org/package/2006/relationships"
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml"
    with ZipFile(OUTPUT / filename, "w", ZIP_DEFLATED) as archive:
        overridden = f'<Override PartName="/word/header1.xml" ContentType="{mime}.header+xml"/>' if header else ""
        archive.writestr("[Content_Types].xml", f"""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="{mime}.document.main+xml"/>{overridden}</Types>""")
        archive.writestr("_rels/.rels", f'<Relationships xmlns="{package}"><Relationship Id="rId1" Type="{office}/officeDocument" Target="word/document.xml"/></Relationships>')
        section = '<w:sectPr><w:headerReference w:type="default" r:id="rId2"/></w:sectPr>' if header else "<w:sectPr/>"
        archive.writestr("word/document.xml", f'<w:document xmlns:w="{namespace}" xmlns:r="{office}"><w:body>{content}{section}</w:body></w:document>')
        if header:
            archive.writestr("word/_rels/document.xml.rels", f'<Relationships xmlns="{package}"><Relationship Id="rId2" Type="{office}/header" Target="header1.xml"/></Relationships>')
            archive.writestr("word/header1.xml", f'<w:hdr xmlns:w="{namespace}">{paragraph(header)}</w:hdr>')


words = [
    "Émilie O’Connor",
    "emilie@example.test",
    "+44 20 7946 0958",
    "Montréal, QC",
    "EXPERIENCE",
    "Property Accounting Analyst",
    "Arbutus Property Group",
    "2022 – 2025",
    "Prepared financial statements and completed monthly bank reconciliations.",
    "EDUCATION",
    "Bachelor of Commerce",
    "Riverbank College",
    "CERTIFICATIONS",
    "CPA preparatory courses, in progress",
    "VOLUNTEERING",
    "Community treasurer, Harbor Food Pantry",
]
make_word("finance.docx", "".join(map(paragraph, words)))
make_word(
    "header-and-table.docx",
    paragraph("EXPERIENCE")
    + f"<w:tbl><w:tr><w:tc>{paragraph('Accounting Clerk')}</w:tc><w:tc>{paragraph('Cédar Partners')}</w:tc></w:tr>"
    + f"<w:tr><w:tc>{paragraph('Reconciled supplier invoices.')}</w:tc><w:tc>{paragraph('2021–2024')}</w:tc></w:tr></w:tbl>",
    header="Émilie O’Connor · emilie@example.test",
)
make_word("empty.docx", paragraph(""))
make_word("support-certificate.docx", "".join(map(paragraph, [
    "CERTIFICATE OF COMPLETION",
    "Credential: Financial Modelling Foundations",
    "Issued by: North Bridge Learning Institute",
    "Issued on: 2025-06-20",
    "Recipient name: Morgan Example",
    "Credential ID: VITA-CRED-FICT-9002",
])))

for source in sorted(BASELINE.glob("*.pdf")):
    copyfile(source, OUTPUT / source.name)


def make_pdf(filename, pages):
    with pdf.open() as document:
        for lines in pages:
            page = document.new_page(width=612, height=792)
            y = 55
            for line in lines:
                if line:
                    page.insert_text((54, y), line, fontsize=11)
                y += 15
        document.save(OUTPUT / filename)


make_pdf("multiple-roles.pdf", [[
    "Casey Smythe", "casey@example.test", "WORK EXPERIENCE", "",
    "Senior Financial Analyst", "North Glen Finance", "2023 - 2025", "- Prepared business forecasts.", "",
    "Accounting Clerk", "Cedar Field Credit", "2020 - 2023", "- Reconciled supplier payments.", "",
    "Bookkeeper", "Silver Shore Services", "2018 - 2020", "- Tracked monthly accruals.",
]])

make_pdf("role-continues.pdf", [[
    "Casey Smythe", "casey@example.test", "WORK EXPERIENCE", "Senior Financial Analyst",
    "North Glen Finance", "2023 - 2025", "- Prepared business forecasts.",
], [
    "- Owned monthly budget reporting.", "", "EDUCATION", "Cleveland College", "Bachelor of Commerce",
]])

make_pdf("repeat-role.pdf", [[
    "Casey Smythe", "casey@example.test", "EXPERIENCE", "Financial Analyst",
    "North Glen Finance", "2023 - 2025", "- Prepared business forecasts.",
    "Financial Analyst", "Cedar Field Credit", "2020 - 2023", "- Reconciled supplier payments.",
    "Bookkeeper", "Silver Shore Services", "2018 - 2020", "- Tracked monthly accruals.",
]])

make_pdf("support-unofficial-transcript.pdf", [[
    "UNOFFICIAL ACADEMIC TRANSCRIPT",
    "Institution: Stonewater College",
    "Student name: Morgan Example",
    "Student Identification Number: VITA-STUDENT-FICT-0823",
    "Program: Bachelor of Commerce",
    "Program status: In progress",
    "Degree awarded: None",
    "Date of birth: 2001-02-03",
    "Course: FIN 313 - Corporate Finance",
    "Grade: A+",
    "Cumulative GPA: 3.87",
    "Printed on: 2026-04-30",
]])

with pdf.open(OUTPUT / "single-column.pdf") as readable, pdf.open(OUTPUT / "image-only.pdf") as scan:
    mixed = pdf.open()
    mixed.insert_pdf(readable)
    mixed.insert_pdf(scan)
    mixed.save(OUTPUT / "mixed-scan.pdf")
    mixed.close()
    readable.save(OUTPUT / "protected.pdf", encryption=pdf.PDF_ENCRYPT_AES_256, owner_pw="fixtureOwner", user_pw="fixtureOnly")

for filename, data in {
    "corrupt.pdf": b"%PDF-1.7\nThe selected file is incomplete.",
    "corrupt.docx": b"Not a Word container.",
    "empty.txt": b" \r\n\t",
    "wrong-type.png": b"Not a supported document.",
    "finance.txt": "\n".join(words).encode(),
    "unicode.txt": "\ufeffZoë D’Àvila – Finance\nzoe@example.test\n+1 (416) 555-0134\n\nEXPERIENCE\nAnalyzed 14 budgets at Café & Co.\n".encode(),
    "support-freeform.txt": b"PROJECT FIELD NOTES\nParticipated in the neighbourhood budget exercise.\nCompared expenses in a spreadsheet.\nReference note: VITA-PRIVATE-OTHER-91.\n",
    "malformed.json": b'{"resume": ',
    "unsupported.json": json.dumps({"version": 9000, "resume": {"name": "TEMP INVALID"}}).encode(),
}.items():
    (OUTPUT / filename).write_bytes(data)

print(f"{len(list(OUTPUT.iterdir()))} fictional document fixtures under {OUTPUT}")
