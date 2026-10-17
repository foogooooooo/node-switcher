#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
export NVM_DIR="$task_root/.tools/nvm"
if [[ ! -f "$NVM_DIR/nvm.sh" || ! -d node_modules ]]; then
  echo '请先在项目目录运行 bash scripts/setup.sh 建立独立环境。'
  exit 1
fi
source "$NVM_DIR/nvm.sh"
nvm use
which node
case "$(command -v node)" in "$NVM_DIR"/versions/node/*) ;; *) echo 'Expected project-local nvm Node.js'; exit 1;; esac
if [[ "${1:-}" == '--demo' ]]; then npm run demo; else npm start; fi
