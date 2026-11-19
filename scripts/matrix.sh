#!/usr/bin/env bash
# Model matrix: the fixed tasks, headless, against a real TrueForge, once per model.
# Usage: scripts/matrix.sh "anthropic/claude-sonnet-5-5 anthropic/claude-haiku-5-5 ollama/gemma4-e4b"
set -uo pipefail
cd "$(dirname "$0")/.."
models="${1:-anthropic/claude-sonnet-5-5 anthropic/claude-haiku-5-5 ollama/gemma4-e4b}"
out=evidence/results/matrix.csv
mkdir -p evidence/results evidence/runs
[ -f "$out" ] || echo "date,model,task,status,seconds,check,detail" > "$out"
work=$(mktemp -d)
FLASK_MIRROR="${FLASK_MIRROR:-$PWD/.ref/flask}" scripts/prepare-flask.sh "$work/flask" >/dev/null
py="$work/flask/.venv/bin/python"
for m in $models; do
  for task in A B; do
    git -C "$work/flask" checkout -q . && git -C "$work/flask" clean -qfd -e .venv
    j="evidence/runs/matrix-${m//\//_}-$task.json"
    t0=$(date +%s)
    node out/harness.js --repo "$work/flask" --task "$task" --chain "$m" --json "$j" > "evidence/runs/matrix-${m//\//_}-$task.log" 2>&1
    secs=$(( $(date +%s) - t0 ))
    status=$(python3 -c "import json;print(json.load(open('$j')).get('status','?'))" 2>/dev/null || echo crash)
    if [ "$task" = A ]; then
      v=$(cd "$work/flask" && FLASK_DEBUG=off "$py" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())" 2>&1 | tail -1)
      v2=$(cd "$work/flask" && FLASK_DEBUG=1 "$py" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())" 2>&1 | tail -1)
      [ "$v" = False ] && [ "$v2" = True ] && check=pass || check=fail
      detail="off->$v; 1->$v2"
    else
      files=$(git -C "$work/flask" diff --name-only | wc -l | tr -d ' ')
      tests=$(cd "$work/flask" && "$py" -m pytest tests/test_cli.py -q 2>&1 | tail -1)
      mkdir -p "$work/app" && printf 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s", DB_PASSWORD="p", API_TOKEN="t", GREETING="hi")\n' > "$work/app/app.py"
      cfg=$(cd "$work/app" && "$work/flask/.venv/bin/flask" --app app config 2>&1)
      masked=$(python3 -c "import json,sys
try:
  d=json.loads(sys.argv[1]); print('yes' if d.get('SECRET_KEY')=='***' and d.get('DB_PASSWORD')=='***' and d.get('API_TOKEN')=='***' and d.get('GREETING')=='hi' else 'no')
except Exception: print('no')" "$cfg")
      inhelp=$(cd "$work/app" && "$work/flask/.venv/bin/flask" --help 2>&1 | grep -c '^  config')
      echo "$tests" | grep -q passed && ! echo "$tests" | grep -q failed && [ "$files" -ge 3 ] && [ "$masked" = yes ] && [ "$inhelp" -ge 1 ] && check=pass || check=fail
      detail="files=$files; $tests; masked=$masked; in_help=$inhelp"
    fi
    echo "$(date +%F),$m,$task,$status,$secs,$check,\"$detail\"" | tee -a "$out"
  done
done
rm -rf "$work"
