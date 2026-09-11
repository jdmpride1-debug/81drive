#!/usr/bin/env bash
# Connection-level timing breakdown for a URL, measured from this runner.
# Shows where the first byte goes: DNS -> TCP -> TLS -> server think time -> transfer.
set -uo pipefail

URL="${1:-https://81drive.com/}"
FMT='dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download} http=%{http_code} proto=%{http_version}\n'

echo "=== Response headers: $URL ==="
curl -sSI --max-time 30 "$URL" 2>&1 | sed 's/^/  /'

echo
echo "=== Cold connection (new TLS handshake each time) x5 ==="
for i in $(seq 1 5); do
  printf '  run %d: ' "$i"
  curl -sS -o /dev/null --max-time 30 -w "$FMT" "$URL" || echo "(failed)"
done

echo
echo "=== Warm connection (connection reuse, 5 requests on one connection) ==="
# -o must be repeated per URL, otherwise only the first body is discarded
curl -sS --max-time 60 -w "$FMT" \
  -o /dev/null "$URL" -o /dev/null "$URL" -o /dev/null "$URL" \
  -o /dev/null "$URL" -o /dev/null "$URL" || echo "(failed)"

echo
echo "=== Compression check ==="
for enc in "gzip" "br" "zstd"; do
  printf '  Accept-Encoding: %-6s -> ' "$enc"
  curl -sS -o /dev/null --max-time 30 -H "Accept-Encoding: $enc" \
    -w 'encoding=%{content_type} size=%{size_download}\n' "$URL" || echo "(failed)"
done

echo
echo "=== Cache / CDN headers ==="
curl -sSI --max-time 30 "$URL" 2>/dev/null \
  | grep -iE '^(cf-|age|cache-control|expires|etag|last-modified|server|x-cache|vary|alt-svc)' \
  | sed 's/^/  /' || echo "  (none found)"
