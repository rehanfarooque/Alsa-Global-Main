#!/usr/bin/env bash
# Probe every public /api/* endpoint and report status + sample.
# Output: one line per endpoint with HTTP code, response size, and a short verdict.
set -u
BASE="http://localhost:3001"

probe() {
  local path="$1"
  local url="${BASE}${path}"
  local tmp
  tmp=$(mktemp)
  local code size
  code=$(curl -s -o "$tmp" -w "%{http_code}" --max-time 12 "$url" || echo "ERR")
  size=$(wc -c < "$tmp" 2>/dev/null || echo 0)
  local body=""
  if [ -s "$tmp" ]; then
    body=$(head -c 200 "$tmp" | tr '\n\t' '  ')
  fi
  rm -f "$tmp"
  printf '%s\t%s\t%s\t%s\n' "$code" "$size" "$path" "$body"
}

export -f probe
export BASE

# Read endpoints from stdin or arg
while IFS= read -r ep; do
  [ -n "$ep" ] && probe "$ep"
done
