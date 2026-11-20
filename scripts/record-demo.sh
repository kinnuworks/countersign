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
# No editor from an earlier take may still be running (see the end of this script).
pkill -KILL -f "user-data-dir=$REPO/.ref/rec" 2>/dev/null || true
rm -rf "$WORK"; mkdir -p "$WORK"
FLASK_MIRROR="${FLASK_MIRROR:-$REPO/.ref/flask}" scripts/prepare-flask.sh "$WORK/flask-3.1.3" >/dev/null
mkdir -p "$WORK/app"
cat > "$WORK/app/app.py" <<'PY'
from flask import Flask

app = Flask(__name__)
app.config.update(SECRET_KEY="dev-secret", DATABASE_PASSWORD="hunter2", API_TOKEN="abc123", STRIPE_KEY="sk_test_1", GREETING="hello")
PY
git -C "$WORK/flask-3.1.3" config user.email demo@example.invalid
git -C "$WORK/flask-3.1.3" config user.name demo
node --env-file-if-exists=.env.local out/setup.js --restore anthropic >/dev/null

# Isolated rig: the committed HEAD as a .vsix in its own VS Code profile, so the recording never
# picks up uncommitted work or touches another VS Code window.
SRC="$OUT/src"; rm -rf "$SRC"
git worktree remove --force "$SRC" 2>/dev/null || true
git worktree add -q --detach "$SRC" HEAD
ln -s "$REPO/node_modules" "$SRC/node_modules"
cp countersign.models.json "$SRC/" 2>/dev/null || true
(cd "$SRC" && node scripts/build.mjs && npx vsce package --no-dependencies --allow-missing-repository -o "$OUT/countersign.vsix" >/dev/null)
U="$OUT/u"; X="$OUT/x"; D="$OUT/drv"
rm -rf "$U" "$X" "$D"; mkdir -p "$U/User" "$D"
python3 - "$U/User/settings.json" "$D" <<'PY'
import json, sys
json.dump({"workbench.startupEditor": "none", "security.workspace.trust.enabled": False, "window.zoomLevel": 1,
  "update.mode": "none", "telemetry.telemetryLevel": "off", "chat.disableAIFeatures": True,
  "workbench.secondarySideBar.defaultVisibility": "hidden", "window.restoreWindows": "none",
  "terminal.integrated.fontSize": 14, "editor.fontSize": 14, "workbench.tips.enabled": False,
  "editor.minimap.enabled": False, "extensions.ignoreRecommendations": True,
  "workbench.enableExperiments": False, "countersign.driverDir": sys.argv[2]}, open(sys.argv[1], "w"), indent=1)
PY
# A readable Countersign sidebar from the first frame: seed the width VS Code restores on start.
mkdir -p "$U/User/globalStorage"
sqlite3 "$U/User/globalStorage/state.vscdb" "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable VALUES ('workbench.sideBar.size', '${SIDEBAR_WIDTH:-390}');"
APP="$(ls -d "$REPO"/.vscode-test/vscode-darwin-*/Visual\ Studio\ Code.app | tail -1)"
CODE="$APP/Contents/MacOS/Code"
"$APP/Contents/Resources/app/bin/code" --user-data-dir="$U" --extensions-dir="$X" --install-extension "$OUT/countersign.vsix" >/dev/null 2>&1
FL="$WORK/flask-3.1.3"
"$CODE" --user-data-dir="$U" --extensions-dir="$X" --disable-workspace-trust "$FL" >/dev/null 2>&1 &
for i in $(seq 1 60); do [ -f "$D/log.txt" ] && break; echo '{"do":"wait","ms":1}' >> "$D/steps.jsonl"; sleep 1; done
[ -f "$D/log.txt" ] || { echo "driver did not start"; exit 1; }
sleep 3
# Keep the display awake: a sleeping or locked screen ends the capture and stalls the editor.
caffeinate -d -i -w $$ &
WINREC_TITLE="flask-3.1.3" tools/winrec 0 "$OUT/seg" 30 2> "$OUT/winrec.log" &
REC=$!
sleep 1
T0=$(python3 -c 'import time;print(time.time())')

say() { printf '%s\n' "$@" >> "$D/steps.jsonl"; }
mark() { echo "$(python3 -c "import time;print(round(time.time()-$T0,1))") $1" >> "$OUT/marks.txt"; }
wait_log() { # wait until the driver has finished every queued step
  python3 - "$D" <<'PY'
import sys, time, os
d = sys.argv[1]
for _ in range(1800):
    n = sum(1 for l in open(os.path.join(d, 'steps.jsonl')) if l.strip())
    try:
        log = open(os.path.join(d, 'log.txt')).read().splitlines()
    except FileNotFoundError:
        log = []
    fin = sum(1 for l in log if l.endswith(' done') or ' error ' in l)
    if fin >= n:
        sys.exit(0)
    time.sleep(0.5)
print('driver timed out'); sys.exit(1)
PY
}
TASK_A="Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."
TASK_B='Add a new built-in CLI command flask config that prints the loaded application'"'"'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as \"***\". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.'
VERIFY_A='FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"'
j() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

: > "$OUT/marks.txt"
mark start
say '{"do":"focusPanel"}' '{"do":"terminal","text":"source .venv/bin/activate"}' '{"do":"wait","ms":1800}' '{"do":"command","id":"workbench.action.terminal.clear"}' '{"do":"terminal","text":"git log -1 --oneline && git status --short"}' '{"do":"wait","ms":2500}'
wait_log; mark "task A"
say '{"do":"select","path":"src/flask/helpers.py","symbol":"get_debug_flag"}' '{"do":"wait","ms":1200}' \
    "{\"do\":\"inline\",\"text\":$(j "$TASK_A"),\"cps\":38}" '{"do":"waitFor","what":"review","timeoutMs":180000}' '{"do":"wait","ms":2500}' \
    '{"do":"hunk","n":1,"decision":"accepted"}' '{"do":"wait","ms":1300}' '{"do":"hunk","n":2,"decision":"accepted"}' \
    '{"do":"waitFor","what":"idle","timeoutMs":120000}' '{"do":"wait","ms":1500}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "$VERIFY_A && git diff --stat")}" '{"do":"wait","ms":4000}'
wait_log; mark "undo"
say '{"do":"command","id":"countersign.undo"}' '{"do":"wait","ms":1500}' '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "git status --short && echo '(clean)'")}" '{"do":"wait","ms":3000}'
wait_log; mark "task B"
say '{"do":"command","id":"workbench.action.closeAllEditors"}' "{\"do\":\"agent\",\"text\":$(j "$TASK_B"),\"cps\":55}" \
    '{"do":"waitFor","what":"review","timeoutMs":400000}' '{"do":"wait","ms":5000}' \
    '{"do":"command","id":"countersign.acceptAll"}' '{"do":"finish","timeoutMs":600000}' '{"do":"wait","ms":2500}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "python -m pytest tests/test_cli.py -q 2>&1 | tail -1; git diff --stat")}" '{"do":"wait","ms":5000}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "cd ../app && flask --app app config | grep -E '\"(SECRET_KEY|DATABASE_PASSWORD|API_TOKEN|STRIPE_KEY|GREETING)\"'; flask --app app --help | grep -E '^  config'; cd ../flask-3.1.3")}" '{"do":"wait","ms":6000}' \
    '{"do":"command","id":"workbench.action.closeSidebar"}' '{"do":"command","id":"workbench.action.closePanel"}' '{"do":"command","id":"countersign.openSession"}' '{"do":"wait","ms":11000}' '{"do":"focusPanel"}'
wait_log; mark "task C"
say '{"do":"command","id":"workbench.action.closeAllEditors"}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "git add -A && git commit -qm 'Task B' && git status --short && echo '(clean)' && npm --prefix $REPO run -s setup -- --break-endpoint anthropic")}" '{"do":"wait","ms":7000}' \
    '{"do":"select","path":"src/flask/helpers.py","symbol":"get_debug_flag"}' '{"do":"wait","ms":800}' \
    "{\"do\":\"inline\",\"text\":$(j "$TASK_A"),\"cps\":60}" '{"do":"waitFor","what":"review","timeoutMs":180000}' '{"do":"wait","ms":2000}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "git status --short && echo '(no files changed)'")}" '{"do":"wait","ms":3500}' \
    '{"do":"command","id":"countersign.acceptAll"}' '{"do":"waitFor","what":"idle","timeoutMs":120000}' '{"do":"wait","ms":1500}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "$VERIFY_A && git commit -qam 'Task C' && npm --prefix $REPO run -s setup -- --restore anthropic")}" '{"do":"wait","ms":5000}'
wait_log; mark "stop"
say "{\"do\":\"agent\",\"text\":$(j "Explain how flask finds the app when you run flask --help, file by file."),\"cps\":70}" '{"do":"waitFor","what":"running","timeoutMs":30000}' '{"do":"wait","ms":7000}' \
    '{"do":"command","id":"countersign.cancel"}' '{"do":"waitFor","what":"idle","timeoutMs":30000}' '{"do":"wait","ms":1500}' \
    '{"do":"command","id":"workbench.action.terminal.clear"}' "{\"do\":\"terminal\",\"text\":$(j "git status --short && echo '(clean)'")}" '{"do":"wait","ms":3500}'
wait_log; mark end
kill -INT $REC 2>/dev/null || true; wait $REC || true
python3 scripts/assemble-rec.py "$OUT"
node --env-file-if-exists=.env.local out/setup.js --restore anthropic >/dev/null
# Force the recording editor closed: a surviving one restarts its driver and replays every step,
# including the Task C provider break, into the next take.
: > "$D/steps.jsonl"
pkill -TERM -f "user-data-dir=$U" 2>/dev/null || true; sleep 3; pkill -KILL -f "user-data-dir=$U" 2>/dev/null || true
git worktree remove --force "$SRC" 2>/dev/null || true
echo "recorded $OUT/raw.mov; marks in $OUT/marks.txt; driver log $D/log.txt"
