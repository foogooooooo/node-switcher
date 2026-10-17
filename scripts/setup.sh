#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
export NVM_DIR="$task_root/.tools/nvm"
if [[ ! -f "$NVM_DIR/nvm.sh" ]]; then
  mkdir -p "$task_root/.tools"
  git clone --depth 1 --branch v0.40.3 https://github.com/nvm-sh/nvm.git "$NVM_DIR"
fi
source "$NVM_DIR/nvm.sh"
nvm install
nvm use
which node
case "$(command -v node)" in "$NVM_DIR"/versions/node/*) ;; *) echo 'Expected project-local nvm Node.js'; exit 1;; esac
npm ci
echo '环境已就绪。运行 bash scripts/launch.sh 启动。'
