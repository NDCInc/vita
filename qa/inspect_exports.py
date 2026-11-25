"""Read Vita exports with independent libraries, outside the browser renderer."""

from hashlib import sha256
from pathlib import Path
from xml.etree.ElementTree import fromstring
from zipfile import ZipFile
import json
import sys

import pymupdf as pdf


def inspect_pdf(path: Path):
    with pdf.open(path) as document:
        pages = []
        for page in document:
            words = page.get_text("words")
            outside = [word[4] for word in words if not page.rect.contains(pdf.Rect(word[:4]))]
            pages.append({"text": page.get_text(), "outside": outside, "words": len(words)})
        return {"pages": pages, "sha256": sha256(path.read_bytes()).hexdigest()}


def inspect_word(path: Path):
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Word package checksum failed")
        for member in archive.namelist():
            if member.endswith((".xml", ".rels")):
                fromstring(archive.read(member))
        document = fromstring(archive.read("word/document.xml"))
        lines = ["".join(el.text or "" for el in paragraph.findall(".//w:t", ns))
                 for paragraph in document.findall(".//w:p", ns)]
        return {"text": "\n".join(lines), "sha256": sha256(path.read_bytes()).hexdigest()}


path = Path(sys.argv[1])
inspect = inspect_pdf if path.suffix == ".pdf" else inspect_word
print(json.dumps(inspect(path)))
