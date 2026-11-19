#!/usr/bin/env bash
# Records the demo: Tasks A, B, C in order (plus undo and Stop), played through the real UI by the
# demo driver against a real local TrueForge, captured from the VS Code window with tools/winrec.
# Model waiting time is cut later; nothing between an instruction and its diff is cut.
#   scripts/record-demo.sh <out-dir>
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
OUT="$(cd "${1:?usage: record-demo.sh <out-dir>}" && pwd)"
WORK="$OUT/work"
rm -rf "$WORK"; mkdir -p "$WORK"
FLASK_MIRROR="${FLASK_MIRROR:-$REPO/.ref/flask}" scripts/prepare-flask.sh "$WORK/flask" >/dev/null
mkdir -p "$WORK/app"
cat > "$WORK/app/app.py" <<'PY'
from flask import Flask

app = Flask(__name__)
app.config.update(SECRET_KEY="dev-secret", DATABASE_PASSWORD="hunter2", API_TOKEN="abc123", STRIPE_KEY="sk_test_1", GREETING="hello")
PY
git -C "$WORK/flask" config user.email demo@example.invalid
git -C "$WORK/flask" config user.name demo
node --env-file-if-exists=.env.local out/setup.js --restore anthropic >/dev/null

scripts/demo-vscode.sh "$WORK/flask" >/dev/null
D="$REPO/.vscode-test/drv"
sleep 4
WINREC_TITLE="flask" tools/winrec 0 "$OUT/raw.mov" 30 2> "$OUT/winrec.log" &
REC=$!
sleep 1
T0=$(python3 -c 'import time;print(time.time())')

say() { printf '%s\n' "$@" >> "$D/steps.jsonl"; }
mark() { echo "$(python3 -c "import time;print(round(time.time()-$T0,1))") $1" >> "$OUT/marks.txt"; }
wait_log() { # wait until the driver has finished every queued step
  local n; n=$(wc -l < "$D/steps.jsonl")
  for i in $(seq 1 900); do
    local done; done=$(grep -c '^.* done$\|^.* error ' "$D/log.txt" 2>/dev/null || echo 0)
    [ "$done" -ge "$n" ] && return 0; sleep 1
  done
  echo "driver timed out"; return 1
}
TASK_A="Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."
TASK_B='Add a new built-in CLI command flask config that prints the loaded application'"'"'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as \"***\". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.'
VERIFY_A='FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"'
j() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

: > "$OUT/marks.txt"
mark start
say '{"do":"focusPanel"}' '{"do":"terminal","text":"source .venv/bin/activate && clear && git log -1 --oneline && git status --short"}' '{"do":"wait","ms":2500}'
wait_log; mark "task A"
say '{"do":"select","path":"src/flask/helpers.py","symbol":"get_debug_flag"}' '{"do":"wait","ms":1200}' \
    "{\"do\":\"inline\",\"text\":$(j "$TASK_A"),\"cps\":38}" '{"do":"waitFor","what":"review","timeoutMs":180000}' '{"do":"wait","ms":2500}' \
    '{"do":"hunk","n":1,"decision":"accepted"}' '{"do":"wait","ms":1300}' '{"do":"hunk","n":2,"decision":"accepted"}' \
    '{"do":"waitFor","what":"idle","timeoutMs":120000}' '{"do":"wait","ms":1500}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && $VERIFY_A && git diff --stat")}" '{"do":"wait","ms":4000}'
wait_log; mark "undo"
say '{"do":"command","id":"countersign.undo"}' '{"do":"wait","ms":1500}' "{\"do\":\"terminal\",\"text\":$(j "clear && git status --short && echo '(clean)'")}" '{"do":"wait","ms":3000}'
wait_log; mark "task B"
say '{"do":"command","id":"workbench.action.closeAllEditors"}' "{\"do\":\"agent\",\"text\":$(j "$TASK_B"),\"cps\":55}" \
    '{"do":"waitFor","what":"review","timeoutMs":400000}' '{"do":"wait","ms":5000}' \
    '{"do":"command","id":"countersign.acceptAll"}' '{"do":"allowCommand","timeoutMs":400000}' '{"do":"waitFor","what":"idle","timeoutMs":400000}' '{"do":"wait","ms":2500}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && python -m pytest tests/test_cli.py -q 2>&1 | tail -2 && git diff --stat")}" '{"do":"wait","ms":5000}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && cd ../app && flask --app app config | head -14 && flask --help | grep -A5 Commands; cd ../flask")}" '{"do":"wait","ms":6000}' \
    '{"do":"command","id":"countersign.openSession"}' '{"do":"wait","ms":9000}'
wait_log; mark "task C"
say '{"do":"command","id":"workbench.action.closeAllEditors"}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && git add -A && git commit -qm 'Task B' && git status --short && echo '(clean)' && npm --prefix $REPO run -s setup -- --break-endpoint anthropic")}" '{"do":"wait","ms":7000}' \
    '{"do":"select","path":"src/flask/helpers.py","symbol":"get_debug_flag"}' '{"do":"wait","ms":800}' \
    "{\"do\":\"inline\",\"text\":$(j "$TASK_A"),\"cps\":60}" '{"do":"waitFor","what":"review","timeoutMs":180000}' '{"do":"wait","ms":2000}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && git status --short && echo '(no files changed)'")}" '{"do":"wait","ms":3500}' \
    '{"do":"command","id":"countersign.acceptAll"}' '{"do":"waitFor","what":"idle","timeoutMs":120000}' '{"do":"wait","ms":1500}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && $VERIFY_A && npm --prefix $REPO run -s setup -- --restore anthropic")}" '{"do":"wait","ms":5000}'
wait_log; mark "stop"
say "{\"do\":\"agent\",\"text\":$(j "Explain how flask finds the app when you run flask --help, file by file."),\"cps\":70}" '{"do":"waitFor","what":"running","timeoutMs":30000}' '{"do":"wait","ms":7000}' \
    '{"do":"command","id":"countersign.cancel"}' '{"do":"waitFor","what":"idle","timeoutMs":30000}' '{"do":"wait","ms":1500}' \
    "{\"do\":\"terminal\",\"text\":$(j "clear && git status --short && echo '(clean)'")}" '{"do":"wait","ms":3500}'
wait_log; mark end
kill -INT $REC; wait $REC || true
node --env-file-if-exists=.env.local out/setup.js --restore anthropic >/dev/null
echo "recorded $OUT/raw.mov; marks in $OUT/marks.txt; driver log $D/log.txt"
