#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m uvicorn backend.app.main:app --host 127.0.0.1 --port "${PORT:-8000}" "$@"
