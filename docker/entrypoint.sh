#!/bin/sh
set -eu

: "${BLINK_DATA_DIR:=/data/blinkchat}"
export BLINK_DATA_DIR

if [ "$(id -u)" -eq 0 ]; then
    # A newly mounted disk can be root-owned. Only change our private child directory.
    mkdir -p "$BLINK_DATA_DIR"
    chown blinkchat:blinkchat "$BLINK_DATA_DIR"
    chmod 700 "$BLINK_DATA_DIR"
    exec gosu blinkchat "$@"
fi

# Also support callers that explicitly supply an already provisioned, non-root user.
mkdir -p "$BLINK_DATA_DIR"
if [ ! -w "$BLINK_DATA_DIR" ]; then
    printf '%s\n' 'BLINK_DATA_DIR must be writable by the application user.' >&2
    exit 1
fi
exec "$@"
