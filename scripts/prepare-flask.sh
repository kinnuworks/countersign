#!/usr/bin/env bash
# Fresh pallets/flask at tag 3.1.3 (commit 22d92470) with a local virtualenv, for the fixed tasks.
# Usage: scripts/prepare-flask.sh <dest-dir>
set -euo pipefail
dest="${1:?usage: prepare-flask.sh <dest-dir>}"
src="${FLASK_MIRROR:-https://github.com/pallets/flask.git}"
rm -rf "$dest"
git clone -q "$src" "$dest"
cd "$dest"
git -c advice.detachedHead=false checkout -q 3.1.3
test "$(git rev-parse --short=8 HEAD)" = "22d92470" || { echo "unexpected commit $(git rev-parse HEAD)" >&2; exit 1; }
# Keep the virtualenv out of git status, so "no files changed" means exactly that.
echo ".venv/" >> .git/info/exclude
# Flask 3.1.3 ships uv.lock; its pinned test dependencies (pytest 8.4, click 8.3) are the ones
# its own test suite was written against. Newer pytest removed a helper tests/test_cli.py imports.
if command -v uv >/dev/null; then
  UV_PROJECT_ENVIRONMENT=.venv uv sync -q --frozen --python 3.12 --no-dev --group tests
else
  python3 -m venv .venv
  .venv/bin/pip install -q -e . "pytest==8.4.2" "click==8.3.1" python-dotenv asgiref greenlet
fi
echo "ready: $dest ($(git rev-parse --short HEAD), $(.venv/bin/python --version))"
