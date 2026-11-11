#!/bin/sh
set -eu

WEB_ROOT="${1:-/opt/noVNC}"
INDEX="$WEB_ROOT/index.html"
TOOLS="${FIREFOX_TOOLS_DIR:-/usr/share/firefox-tools}"

test -f "$WEB_ROOT/app/firefox-input.js"
test -f "$WEB_ROOT/app/styles/firefox-input.css"
grep -q '_updateScale()' "$WEB_ROOT/core/rfb.js"
grep -q 'get scale()' "$WEB_ROOT/core/display.js"

if grep -q 'installFirefoxInput(UI)' "$INDEX"; then
    exit 0
fi

TEMP="$(mktemp "$WEB_ROOT/.index.XXXXXX")"
trap 'rm -f "$TEMP"' EXIT HUP INT TERM
awk -f "$TOOLS/install-web-input.awk" "$INDEX" > "$TEMP"
cat "$TEMP" > "$INDEX"
