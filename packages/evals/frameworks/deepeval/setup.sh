#!/usr/bin/env bash
# One command to get the DeepEval cross-check running from a clean clone.
# Its own venv on purpose -- deepeval's dependency tree must not perturb the
# engine's venv, since a broken engine is a far worse problem than a missing
# eval framework.
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv venv
./venv/bin/pip install --upgrade pip --quiet
./venv/bin/pip install -r requirements.txt --quiet

echo
echo "DeepEval ready. Next:"
echo "  ./venv/bin/python run_deepeval.py            # offline cross-check, no API spend"
echo "  ./venv/bin/python run_deepeval.py --live     # calls the engine, costs money"
