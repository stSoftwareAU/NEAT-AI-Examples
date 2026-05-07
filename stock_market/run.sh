#!/bin/bash
set -euo pipefail

# Stock-Market Direction Prediction Example Runner
#
# Evolves a NEAT-AI controller that predicts next-period direction
# (up/down) on the public S&P 500 monthly-close dataset, saves the
# champion creature, writes a per-day signal log, and renders an
# animated SVG snapshot of the test window to
# docs/screenshots/stock_market.svg.
#
# ⚠️ Teaching example only — not investment advice.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "📈 Stock-Market Direction Prediction Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  stock_market/stock_market.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/stock_market.svg" ]]; then
  deno fmt docs/screenshots/stock_market.svg > /dev/null
fi
