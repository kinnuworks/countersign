#!/usr/bin/env bash
# In-editor end-to-end checks against a real local TrueForge and real models, on a fresh
# pallets/flask 3.1.3. Task A + undo + cancel, then Task C (unreachable primary -> fallback).
set -euo pipefail
cd "$(dirname "$0")/.."
TF="${TRUEFORGE_URL:-http://localhost:8790}"
curl -sf -m 5 "$TF/healthz" >/dev/null || { echo "e2e: TrueForge is not running at $TF (see README: Start TrueForge)"; exit 1; }
work="${E2E_WORK:-$(mktemp -d)}"
FLASK_MIRROR="${FLASK_MIRROR:-$PWD/.ref/flask}"
[ -d "$FLASK_MIRROR/.git" ] || FLASK_MIRROR=https://github.com/pallets/flask.git
FLASK_MIRROR="$FLASK_MIRROR" scripts/prepare-flask.sh "$work/flask" >/dev/null
node out/setup.js --broken-endpoint >/dev/null
mkdir -p evidence/runs
echo "e2e: Task A, undo, cancel (default chain)"
E2E_OUT=evidence/runs/e2e-a.json node out/e2e-run.js "$work/flask" 2>&1 | grep -E '^\[e2e' || true
test -f evidence/runs/e2e-a.json || { echo "e2e: Task A run failed"; exit 1; }
git -C "$work/flask" checkout -q .
echo "e2e: Task C (unreachable endpoint first, then fallback)"
E2E_ONLY_A=1 E2E_CHAIN=broken-endpoint/unreachable,anthropic/claude-sonnet-5-5 E2E_OUT=evidence/runs/e2e-c.json node out/e2e-run.js "$work/flask" 2>&1 | grep -E '^\[e2e' || true
test -f evidence/runs/e2e-c.json || { echo "e2e: Task C run failed"; exit 1; }
python3 - <<'PY'
import json
a = json.load(open('evidence/runs/e2e-a.json')); c = json.load(open('evidence/runs/e2e-c.json'))
assert a['taskA_verify'] == 'False' and a['taskA_gitBeforeAccept'] == 'clean' and a['undo_git'] == 'clean', a
assert a['cancel_status'] == 'cancelled' and a['cancel_git'] == 'clean' and a['cancel_latencyMs'] < 3000, a
models = [x['model'] for x in c['taskA_attempts']]
assert models[0].startswith('broken-endpoint') and models[-1] != models[0] and c['taskA_verify'] == 'False' and c['taskA_gitBeforeAccept'] == 'clean', c
print(f"e2e: passed (Task A review in {a['taskA_reviewAfterMs']} ms; cancel {a['cancel_latencyMs']} ms; Task C fell back after {len(models)-1} failed attempts)")
PY
rm -rf "$work"
