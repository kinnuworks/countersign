#!/usr/bin/env bash
# Opens the recording copy of VS Code with Countersign on a flask checkout, driven by
# .vscode-test/drv/steps.jsonl (demo driver). Usage: scripts/demo-vscode.sh <flask-dir>
set -euo pipefail
cd "$(dirname "$0")/.."
flask="${1:?usage: demo-vscode.sh <flask-dir>}"
APP0="$(ls -d "$PWD"/.vscode-test/vscode-darwin-*/Visual\ Studio\ Code.app | tail -1)"
osascript -e "tell application \"$APP0\" to quit" 2>/dev/null || true
sleep 1
pkill -f "\.vscode-test/vscode-darwin" 2>/dev/null || true
for i in $(seq 1 20); do pgrep -f "\.vscode-test/vscode-darwin" >/dev/null || break; sleep 0.5; done
D="$PWD/.vscode-test/drv"; rm -rf "$D"; mkdir -p "$D"
APP="$(ls -d "$PWD"/.vscode-test/vscode-darwin-*/Visual\ Studio\ Code.app | tail -1)"
"$APP/Contents/MacOS/Code" --user-data-dir="$PWD/.vscode-test/u" --extensions-dir="$PWD/.vscode-test/x" \
  --extensionDevelopmentPath="$PWD" --disable-workspace-trust "$flask" >/dev/null 2>&1 &
for i in $(seq 1 60); do [ -f "$D/log.txt" ] && break; echo '{"do":"wait","ms":1}' >> "$D/steps.jsonl"; sleep 1; done
echo "ready"
