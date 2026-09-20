#!/usr/bin/env bash
# Launch Web CC Terminal (the backend also serves the frontend).
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r backend/requirements.txt

export CC_WEB_HOST="${CC_WEB_HOST:-127.0.0.1}"
export CC_WEB_PORT="${CC_WEB_PORT:-8000}"
export CC_WEB_AUTH="${CC_WEB_AUTH:-1}"

if [ "$CC_WEB_AUTH" != "0" ] && [ -z "${CC_WEB_TOKEN:-}" ]; then
  CC_WEB_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  export CC_WEB_TOKEN
fi

echo "================================================================"
echo " Web CC Terminal"
echo "   URL   : http://${CC_WEB_HOST}:${CC_WEB_PORT}"
echo "   Token : ${CC_WEB_TOKEN:-<authentication disabled>}"
echo "   (set CC_WEB_AUTH=0 to disable auth on localhost)"
echo "================================================================"

exec python3 -m uvicorn backend.main:app --host "$CC_WEB_HOST" --port "$CC_WEB_PORT"
