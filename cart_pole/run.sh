#!/bin/bash
set -euo pipefail

# Cart-Pole Balancing Example Runner
#
# Evolves a NEAT-AI controller that balances an inverted pole on a
# moving cart, saves the champion creature, and writes an SVG snapshot
# of the run to docs/screenshots/cart_pole.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🎢 Cart-Pole Balancing Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  cart_pole/cart_pole.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/cart_pole.svg" ]]; then
  deno fmt docs/screenshots/cart_pole.svg > /dev/null
fi
if [[ -f "docs/screenshots/cart_pole_evolution.svg" ]]; then
  deno fmt docs/screenshots/cart_pole_evolution.svg > /dev/null
fi
