#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if [[ ! -f .env ]]; then
  echo "오류: $project_dir/.env 파일이 없습니다. .env.example을 복사한 뒤 API_KEY를 설정해주세요." >&2
  exit 1
fi

if ! awk -F= '
  /^[[:space:]]*API_KEY[[:space:]]*=/ {
    value = $0
    sub(/^[^=]*=/, "", value)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    if (value != "" && value != "\"\"" && value != "\047\047") found = 1
  }
  END { exit found ? 0 : 1 }
' .env; then
  echo "오류: .env의 API_KEY에 access token을 설정해주세요." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

target="${1:-start}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$target" in
  start)
    exec npm run start -- "$@"
    ;;
  ios)
    exec npm run ios -- "$@"
    ;;
  android)
    exec npm run android -- "$@"
    ;;
  *)
    echo "사용법: ./dev.sh [start|ios|android] [추가 옵션]" >&2
    exit 2
    ;;
esac
