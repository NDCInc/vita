"""Create fictional profiles with sidebar and main text drawn independently."""
from pathlib import Path
import pymupdf as pdf

out = Path(__file__).resolve().parent / "fixtures"
def profile(name, *, side="left", french=False, width=612, offset=0):
    doc = pdf.open()
    page = doc.new_page(width=width, height=792)
    side_x, body_x = (20, width * .35) if side == "left" else (width * .68, 28)
    def lines(x, rows):
        for y, text, size in rows:
            page.insert_text((x, y), text, fontsize=size)
    lines(side_x, [
        (51+offset, "Coordonnées" if french else "Contact", 14),
        (72+offset, "+1 416-555-0124 (Mobile)", 9), (84+offset, "nora.mercier@example.", 9),
        (96+offset, "test", 9), (114+offset,"www.linkedin.com/in/nora-mercier", 8),
        (125+offset,"(LinkedIn)",9), (140+offset,"ledger.example (Company)", 9),
        (184+offset,"Principales compétences" if french else "Top Skills",14),
        (205+offset,"Financial Analysis",10),(218+offset,"Microsoft Excel",10),(231+offset,"Economics",10),
        (265+offset,"Langues" if french else "Languages",14),
        (284+offset,"English (Native or Bilingual)",9),(298+offset,"French (Professional)",9),
        (337+offset,"Certifications",14),(357+offset,"Ledger Foundations",10),
        (378+offset,"Data Fluency: Methods &",10),(390+offset,"Practice",10),
        (411+offset,"Reporting Essentials",10),
    ])
    lines(body_x, [
        (61,"Nora Mercier",24),(85,"Financial Analyst",13),(103,"Ottawa, Ontario, Canada",10),
        (148,"Résumé" if french else "Summary",16),(172,"I prepare forecasts for local teams.",11),
        (222,"Expérience" if french else "Experience",16),
        (250,"Northern Ledger Group",14),(271,"Senior Financial Analyst",12),
        (288,"January 2022 - Present (4 years)",10),(307,"Ottawa, Ontario",10),
        (335,"Prepared monthly cash forecasts.",11),
        (390,"Harbour Accounts",14),(412,"Accounting Clerk",12),
        (428,"June 2019 - December 2021",10),(451,"Reconciled monthly ledger balances.",11),
        (766,"Page 1 of 2",8),
    ])
    page = doc.new_page(width=width,height=792)
    lines(body_x,[(55,"Formation" if french else "Education",16),(80,"Fictional Lake University",14),
          (101,"Bachelor of Commerce",12),(119,"2015 - 2019",10),(760,"Page 2 of 2",8)])
    doc.save(out/name, no_new_id=True)
    doc.close()

profile("profile-sidebar.pdf")
profile("profile-staggered.pdf", width=595, offset=7, french=True)
profile("profile-mirrored.pdf", side="right", offset=2)

# The PDF has no text layer. Expected words are baked into the image pixels.
with pdf.open() as original:
    page = original.new_page(width=612,height=480)
    for y,line,size in [(55,"Amelie Fortin",23),(86,"amelie@example.test",15),(133,"EXPERIENCE",17),
            (164,"Accounting Analyst",16),(193,"Northern Lake Group",15),(221,"2022 - 2025",15),
            (259,"Prepared monthly financial reports.",15)]:
        page.insert_text((50,y),line,fontsize=size)
    png = page.get_pixmap(matrix=pdf.Matrix(2,2),alpha=False).tobytes("png")
    (out/"scan-clear.png").write_bytes(png)
    with pdf.open() as scan:
        page = scan.new_page(width=612,height=480)
        page.insert_image(page.rect,stream=png)
        scan.save(out/"scan-clear.pdf",no_new_id=True)
        with pdf.open() as mixed:
            mixed.insert_pdf(original)
            mixed.insert_pdf(scan)
            mixed.save(out/"scan-readable-and-image.pdf",no_new_id=True)
