#!/usr/bin/env python3
"""
Deploy site/ to Vercel as a static project. No dependencies beyond Python 3.

  VERCEL_TOKEN=... [VERCEL_TEAM_ID=team_...] [VERCEL_PROJECT=stonk-packs] python3 scripts/deploy-site.py [--preview]

Uploads every file under site/ inline through the deployments API, waits for the
deployment to be ready, and prints its URLs. Production by default; --preview makes a
preview deployment instead. The token is read from the environment and never printed.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOKEN = os.environ.get('VERCEL_TOKEN')
TEAM = os.environ.get('VERCEL_TEAM_ID', '')
PROJECT = os.environ.get('VERCEL_PROJECT', 'stonk-packs')
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site')
PREVIEW = '--preview' in sys.argv

if not TOKEN:
    sys.exit('set VERCEL_TOKEN')


def api(method, path, body=None):
    q = ('&' if '?' in path else '?') + f'teamId={TEAM}' if TEAM else ''
    req = urllib.request.Request('https://api.vercel.com' + path + q, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')[:600]
        sys.exit(f'{method} {path}: HTTP {e.code} {detail}')


files = []
total = 0
for dirpath, _, names in os.walk(ROOT):
    for name in sorted(names):
        if name.startswith('.'):
            continue
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
        data = open(full, 'rb').read()
        total += len(data)
        files.append({'file': rel, 'data': base64.b64encode(data).decode(), 'encoding': 'base64'})
print(f'{len(files)} files, {total / 1024:.0f} KB')

body = {
    'name': PROJECT,
    'files': files,
    'projectSettings': {'framework': None, 'buildCommand': None, 'outputDirectory': None, 'installCommand': None},
    'meta': {'source': 'scripts/deploy-site.py'},
}
if not PREVIEW:
    body['target'] = 'production'
dep = api('POST', '/v13/deployments', body)
dep_id = dep['id']
print('deployment', dep_id, 'created; waiting')
for _ in range(120):
    time.sleep(3)
    cur = api('GET', f'/v13/deployments/{dep_id}')
    state = cur.get('readyState') or cur.get('status')
    if state in ('READY', 'ERROR', 'CANCELED'):
        break
    print(' ', state)
print('state:', state)
if state != 'READY':
    sys.exit(json.dumps(cur.get('errorMessage') or cur, indent=1)[:1500])
urls = ['https://' + cur['url']] + ['https://' + a for a in (cur.get('alias') or [])]
for u in urls:
    print(u)
