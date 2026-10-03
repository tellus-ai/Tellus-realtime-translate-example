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

if [[ ! -d node_modules/@tellus-ai/audio-sdk/vendor ]]; then
  if [[ -z "${TELLUS_AUDIO_ENGINE_TOKEN:-}" ]] && ! grep -Eq '^[[:space:]]*TELLUS_AUDIO_ENGINE_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]' .env; then
    echo "오류: 오디오 엔진 설치에 TELLUS_AUDIO_ENGINE_TOKEN이 필요합니다. .env 또는 셸 환경변수에 설정해주세요." >&2
    exit 1
  fi
  npm install
fi

exec npm run dev -- "$@"
