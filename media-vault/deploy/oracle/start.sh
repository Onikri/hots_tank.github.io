#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
python3 - <<'PY'
from pathlib import Path
from urllib.parse import urlsplit
import re
values = dict(line.split('=',1) for line in Path('.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
host=values.get('SERVER_NAME','')
if not re.fullmatch(r'[a-zA-Z0-9.-]+',host) or '.' not in host or 'replace-' in host:
    raise SystemExit('Set SERVER_NAME in the private .env before starting.')
# The verified owner may configure the private OAuth secret through the HTTPS
# settings form. Until then metadata works and Drive imports remain unavailable.
origin=urlsplit(values.get('ALLOWED_ORIGIN',''))
if origin.scheme != 'https' or not origin.netloc or origin.path not in ('','/'):
    raise SystemExit('ALLOWED_ORIGIN must be the HTTPS website origin.')
Path('.env').chmod(0o600)
PY
install -d -m 700 -o 1000 -g 1000 data data/temporary
docker compose --file compose.yaml up --detach --build
printf '%s\n' 'MediaVault started. Add https://<SERVER_NAME>/oauth/callback to the Google OAuth web client redirects.'
