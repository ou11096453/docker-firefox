#!/bin/sh

set -eu

if [ -z "${DISPLAY:-}" ]; then
    ENV_FILE="${1:-/tmp/.cont-env-internal}"
    [ -r "$ENV_FILE" ] || exit 1
    # Read the selected local display without evaluating the environment snapshot.
    DISPLAY="$(awk '
        /^export DISPLAY=":[0-9]+(\.[0-9]+)?"$/ {
            sub(/^export DISPLAY="/, "")
            sub(/"$/, "")
            print
            exit
        }
    ' "$ENV_FILE")"
fi

[ -n "${DISPLAY:-}" ] || exit 1
export DISPLAY
xdotool search --onlyvisible --class firefox
