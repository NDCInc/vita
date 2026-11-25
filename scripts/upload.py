"""Publish versioned research, static assets, source and finally the website entry point."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DIST = Path(__file__).resolve().parent.parent / 'dist'


def upload(item, path):
    data = path.read_bytes()
    if sha256(data).hexdigest() != item['sha256']:
        raise ValueError('File changed after packaging: ' + item['key'])
    request = Request(item['url'], data=data, headers=item['headers'], method='PUT')
    for attempt in range(3):
        try:
            with urlopen(request, timeout=120) as response:
                version = response.headers.get('x-amz-version-id')
                if not version:
                    raise ValueError('Expected versioned storage for ' + item['key'])
                return {'key': item['key'], 'sha256': item['sha256'], 'version': version}
        except HTTPError as error:
            if attempt == 2 or error.code not in (408, 429, 500, 502, 503, 504):
                raise RuntimeError(f'S3 returned HTTP {error.code} for {item["key"]}') from None
        except (URLError, TimeoutError):
            if attempt == 2:
                raise RuntimeError('Connection failed for ' + item['key']) from None
        time.sleep(2 ** attempt)


def release(payload):
    site = payload if isinstance(payload, list) else payload['site']
    evidence = [] if isinstance(payload, list) else payload.get('research', [])
    if any(item['key'] == 'index.html' for item in site) and not evidence:
        raise ValueError('A production release needs its private research packet.')
    results = [upload(item, Path(item['path'])) for item in evidence]
    def site_object(item):
        return upload(item, DIST / item.get('buildKey', item['key']))
    with ThreadPoolExecutor(max_workers=6) as executor:
        results.extend(executor.map(site_object, [item for item in site if item['key'].startswith('assets/')]))
    pointers = sorted((item for item in site if not item['key'].startswith('assets/')), key=lambda item: item['key'] == 'index.html')
    results.extend(site_object(item) for item in pointers)
    return results


if __name__ == '__main__':
    print(json.dumps(release(json.load(sys.stdin)), indent=2))
