#!/bin/sh
# Launched by jlesage/baseimage-gui inside the X session.

set -e

APP_DIR="${CHAT2API_APP_DIR:-/app}"

export DBUS_SESSION_BUS_ADDRESS=/dev/null
export DBUS_SYSTEM_BUS_ADDRESS=/dev/null
export NO_AT_BRIDGE=1
export HOME=/root

# Find the binary
APP_BIN=""
for name in chat2api Chat2API; do
    if [ -f "${APP_DIR}/${name}" ] && [ -x "${APP_DIR}/${name}" ]; then
        APP_BIN="${APP_DIR}/${name}"
        break
    fi
done

if [ -z "${APP_BIN}" ]; then
    echo "ERROR: no Chat2API binary found under ${APP_DIR}" >&2
    exit 1
fi

echo "Launching: ${APP_BIN}" >&2
cd "${APP_DIR}"
exec "${APP_BIN}" \
    --lang="en-US" \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer
