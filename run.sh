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

generated_token=0
if [ "$CC_WEB_AUTH" != "0" ] && [ -z "${CC_WEB_TOKEN:-}" ]; then
  CC_WEB_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  export CC_WEB_TOKEN
  generated_token=1
fi

echo "================================================================"
echo " Web CC Terminal"
echo "   URL   : http://${CC_WEB_HOST}:${CC_WEB_PORT}"
if [ "$CC_WEB_AUTH" = "0" ]; then
  echo "   Token : <authentication disabled>"
elif [ "$generated_token" = "1" ] && [ -t 1 ]; then
  echo "   Token : ${CC_WEB_TOKEN}"
elif [ "$generated_token" = "1" ]; then
  token_file="${CC_WEB_TOKEN_FILE:-$HOME/.cc-web-token}"
  token_tmp="$(mktemp "${token_file}.XXXXXX")"
  chmod 600 "$token_tmp"
  printf '%s\n' "$CC_WEB_TOKEN" > "$token_tmp"
  mv -f "$token_tmp" "$token_file"
  if [ -n "${CC_WEB_TOKEN_FILE:-}" ]; then
    token_label="$CC_WEB_TOKEN_FILE"
  else
    token_label="~/.cc-web-token"
  fi
  echo "   Token : <generated; stored in $token_label with mode 0600>"
else
  echo "   Token : <set via CC_WEB_TOKEN; hidden>"
fi
echo "   (set CC_WEB_AUTH=0 to disable auth on localhost)"
echo "================================================================"

exec python3 -m uvicorn backend.main:app --host "$CC_WEB_HOST" --port "$CC_WEB_PORT"
