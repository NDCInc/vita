"""Copy the pinned OCR language data into the static site."""
from pathlib import Path
from shutil import copyfile

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets"

if __name__ == "__main__":
    scan = ASSETS / "scan-lang-v1"
    scan.mkdir(parents=True, exist_ok=True)
    for code in ["eng", "fra"]:
        src = ROOT / "node_modules" / "@tesseract.js-data" / code / "4.0.0_best_int" / (code+".traineddata.gz")
        copyfile(src, scan / src.name)
