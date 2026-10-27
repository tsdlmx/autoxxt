#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 没检测到 node，请先安装 Node.js 18+ : https://nodejs.org/"
  exit 1
fi

exec node src/index.js "$@"
