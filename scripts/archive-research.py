"""Build a private release measurement packet from Vita's fictional test runs."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
METRICS = ('ms', 'facts', 'fixtures', 'actionY', 'viewport', 'realImageOCR', 'entries', 'failurePaths',
           'finishMs', 'liveText', 'commits', 'backup', 'frames', 'streamedBytes', 'twoTaps')


def add(archive, name, content):
    entry = ZipInfo(name)
    entry.compress_type = ZIP_DEFLATED
    entry.external_attr = 0o644 << 16
    archive.writestr(entry, content)


def measurement(path):
    data = json.loads(path.read_text())
    cases = data.get('reports', data.get('results'))
    if not isinstance(cases, list) or not cases:
        raise ValueError('Expected a Vita regression report: ' + path.name)
    rows = []
    for case in cases:
        name = case.get('test', case.get('name'))
        if not name or case.get('status') not in ('pass', 'fail'):
            raise ValueError('Unrecognized test result: ' + path.name)
        # Do not collect form input, recognized speech, error text, filenames or screenshots.
        rows.append({'test': name, 'status': case['status'], **{k: case[k] for k in METRICS if k in case}})
    return {'engine': data.get('engine', cases[0].get('engine')), 'device': data.get('device'),
            'sourceSha256': sha256(path.read_bytes()).hexdigest(), 'cases': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--register', required=True, type=Path, help='Company research source register')
    parser.add_argument('--synthetic-benchmark', type=Path, help='Privately authored fictional evaluation set')
    parser.add_argument('reports', nargs='+', type=Path)
    args = parser.parse_args()
    reports = [measurement(p) for p in args.reports]
    with ZipFile(args.output, 'w') as archive:
        add(archive, 'release-manifest.json', args.manifest.read_bytes())
        add(archive, 'source-register.md', args.register.read_bytes())
        add(archive, 'regression-results.json', json.dumps(reports, ensure_ascii=False, indent=2).encode())
        add(archive, 'voice-service.json', (ROOT/'scripts/voice-service.json').read_bytes())
        fields = {p.name: sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/'qa/fixtures').iterdir()) if p.is_file()}
        add(archive, 'public-fixture-hashes.json', json.dumps(fields, indent=2).encode())
        if args.synthetic_benchmark:
            add(archive, 'independent-synthetic-benchmark.zip', args.synthetic_benchmark.read_bytes())
    print(json.dumps({'bytes': args.output.stat().st_size, 'sha256': sha256(args.output.read_bytes()).hexdigest(),
                      'reports': len(reports), 'checks': sum(len(r['cases']) for r in reports)}))


if __name__ == '__main__':
    main()
