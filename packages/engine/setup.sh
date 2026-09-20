#!/usr/bin/env bash
# One command to get the engine running from a clean clone.
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv venv
./venv/bin/pip install --upgrade pip --quiet
./venv/bin/pip install -r requirements.txt --quiet
./venv/bin/pip install -e ../shared -e . --quiet

echo
echo "Engine ready. Next:"
echo "  ./venv/bin/pytest -q              # 28 offline tests, no API key needed"
echo "  ./venv/bin/python test_live.py    # live scenarios against GPT-4o"
echo "  ./venv/bin/uvicorn server:app --port 8000   # the service Person 1 calls"
