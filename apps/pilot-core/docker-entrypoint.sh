#!/bin/sh
# No privilege escalation / chown here: Compose uses cap_drop: ALL.
# Volume ownership is prepared by the pilot-core-data-init service.
set -eu
exec "$@"
