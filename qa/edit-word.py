"""Make two ordinary edits to a fictional Word export for independent round-trip tests."""
from pathlib import Path
from sys import argv
from xml.etree import ElementTree as xml
from zipfile import ZipFile

source, destination, mode = map(str, argv[1:])
ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with ZipFile(source) as before, ZipFile(destination, 'w') as after:
    for info in before.infolist():
        content = before.read(info)
        if info.filename == 'word/document.xml':
            root = xml.fromstring(content)
            if mode == 'rename':
                matches = [t for t in root.iter(ns+'t') if t.text=='Nora Mercier']
                assert len(matches)==1
                matches[0].text='Nora Lee'
            elif mode == 'paragraph':
                body = root.find(ns+'body')
                paragraph = xml.Element(ns+'p')
                xml.SubElement(xml.SubElement(paragraph, ns+'r'), ns+'t').text='Reviewed a new budget workbook in Word.'
                body.insert(len(body)-1, paragraph)
            else:
                raise ValueError('Unknown edit')
            content = xml.tostring(root, encoding='utf-8', xml_declaration=True)
        after.writestr(info,content)
