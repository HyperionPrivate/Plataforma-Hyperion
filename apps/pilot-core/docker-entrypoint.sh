#!/bin/sh
set -eu
# Named volumes often mount as root; ensure UID 10001 can write PULSO_DATA_DIR.
DATA_DIR="${PULSO_DATA_DIR:-/data}"
mkdir -p "${DATA_DIR}/documents"
if [ "$(id -u)" = "0" ]; then
  chown -R 10001:10001 "${DATA_DIR}"
  exec setpriv --reuid=10001 --regid=10001 --clear-groups -- "$@"
fi
exec "$@"
