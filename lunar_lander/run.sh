#!/bin/bash
set -euo pipefail

# Lunar Lander Descent Example Runner
#
# Evolves a NEAT-AI controller that lands a simplified 2D lunar lander
# on a flat pad, saves the champion creature, and writes an SVG snapshot
# of the descent to docs/screenshots/lunar_lander.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🚀 Lunar Lander Descent Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  lunar_lander/lunar_lander.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/lunar_lander.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander.svg > /dev/null
fi
if [[ -f "docs/screenshots/lunar_lander_evolution.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander_evolution.svg > /dev/null
fi
if [[ -f "docs/screenshots/lunar_lander/evolution.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander/evolution.svg > /dev/null
fi
