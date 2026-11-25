"""Package Vita's source and write a manifest for the exact staged build."""
import argparse
import hashlib
import json
import mimetypes
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SOURCE_FILES = (
    "LICENSE", "README.md", "THIRD-PARTY.md", ".gitignore", "index.html", "vite.config.js",
    "package.json", "package-lock.json", "infra/site.yaml", "scripts/bundle.py", "scripts/upload.py",
    "qa/fixtures.py", "qa/inspect_exports.py", "qa/suite.cjs", "qa/README.md", "qa/model.mjs", "qa/stage-server.cjs", "qa/supporting-model.mjs",
    "qa/experience.cjs", "qa/profile-fixtures.py", "qa/edit-word.py", "qa/evidence.mjs",
    "scripts/prepare-assets.py", "scripts/voice-service.json", "scripts/archive-research.py",
    "voice-service/handler.mjs", "voice-service/live.mjs", "voice-service/handler.test.mjs", "voice-service/package.json", "voice-service/package-lock.json",
)


FIXTURES = (
    "additional-sections.pdf", "corrupt.docx", "corrupt.pdf", "empty.docx", "empty.txt",
    "finance.docx", "finance.txt", "french.pdf", "header-and-table.docx", "image-only.pdf",
    "international-phone.pdf", "malformed.json", "mixed-scan.pdf", "multiple-roles.pdf",
    "page-break.pdf", "protected.pdf", "repeat-role.pdf", "role-continues.pdf",
    "single-column.pdf", "two-columns.pdf", "unicode.txt", "unsupported.json", "wrong-type.png",
    "support-unofficial-transcript.pdf", "support-certificate.docx", "support-freeform.txt",
    "profile-sidebar.pdf", "profile-staggered.pdf", "profile-mirrored.pdf", "scan-clear.pdf",
    "scan-clear.png", "scan-readable-and-image.pdf", "spoken-work.wav", "spoken-microphone.wav",
)


def bundle():
    if not (DIST / "index.html").is_file():
        raise SystemExit("Run npm run build first.")
    files = [ROOT / name for name in SOURCE_FILES]
    files.extend(ROOT / "qa" / "fixtures" / name for name in FIXTURES)
    files.extend(sorted((ROOT / "licenses").glob("*.txt")))
    missing = [file.relative_to(ROOT).as_posix() for file in files if not file.is_file()]
    if missing:
        raise SystemExit("Missing source archive files: " + ", ".join(missing))
    files.extend(file for file in (ROOT / "src").rglob("*") if file.is_file())
    files = sorted(file for file in files if file.is_file())
    with ZipFile(DIST / "source.zip", "w") as archive:
        for file in files:
            entry = ZipInfo("vita/" + file.relative_to(ROOT).as_posix())
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, file.read_bytes())


def manifest():
    content_types = {
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".wasm": "application/wasm",
    }
    result = []
    for file in sorted(file for file in DIST.rglob("*") if file.is_file()):
        key = file.relative_to(DIST).as_posix()
        mime = content_types.get(file.suffix) or mimetypes.guess_type(key)[0] or "application/octet-stream"
        result.append({
            "key": key,
            "bytes": file.stat().st_size,
            "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "headers": {
                "Content-Type": mime,
                "Cache-Control": "public, max-age=31536000, immutable" if key.startswith("assets/") else "no-cache, max-age=0, must-revalidate",
                **({"Content-Disposition": 'attachment; filename="vita-source.zip"'} if key == "source.zip" else {}),
            },
        })
    return sorted(result, key=lambda obj: (obj["key"] == "index.html", obj["key"] == "source.zip", obj["key"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    bundle()
    args.manifest.write_text(json.dumps(manifest(), indent=2) + "\n", encoding="utf-8")
