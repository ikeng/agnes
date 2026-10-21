#!/usr/bin/env bash
# Legacy media-URL fallback.
#
# Current guidance: prefer the patched agnes CLI, which keeps a provider
# fallback chain (Litterbox -> tmpfiles -> Uguu -> x0.at):
#
#   agnes media url ./frame.png --ttl 12h
#
# This script is kept for environments where the CLI is unavailable. It tries
# `agnes media url` first and falls back to the original Litterbox-only upload.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  agnes-media-url.sh <file-or-url> [ttl]

Examples:
  agnes-media-url.sh ./frame.png
  agnes-media-url.sh ./frame.png 12h
  agnes-media-url.sh https://example.com/frame.png

If the input is already an http(s) URL, the script prints it unchanged.
For local files it prefers `agnes media url` (patched CLI) and otherwise
uploads to Litterbox as a legacy fallback.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 1 ]]; then
  usage
  exit 0
fi

input="$1"
ttl="${2:-1h}"

# Validate ttl early (both CLI and the legacy endpoint accept these values).
case "$ttl" in
  1h|12h|24h|72h) ;;
  *)
    printf 'Unsupported ttl "%s". Use one of: 1h, 12h, 24h, 72h.\n' "$ttl" >&2
    exit 1
    ;;
esac

if [[ "$input" =~ ^https?:// ]]; then
  printf '%s\n' "$input"
  exit 0
fi

if [[ ! -r "$input" ]]; then
  printf 'Input must be a readable file path or an http(s) URL: %s\n' "$input" >&2
  exit 1
fi

# Preferred path: patched CLI with provider fallback.
if command -v agnes >/dev/null 2>&1; then
  if url="$(agnes media url "$input" --ttl "$ttl" 2>/dev/null)" && [[ -n "$url" ]]; then
    printf '%s\n' "$url"
    exit 0
  fi
  printf 'agnes media url failed; falling back to legacy Litterbox upload.\n' >&2
fi

# Legacy fallback: Litterbox only (single provider, may be rate-limited/blocked).
curl -sS https://litterbox.catbox.moe/resources/internals/api.php \
  -F "reqtype=fileupload" \
  -F "time=${ttl}" \
  -F "fileToUpload=@${input}"
