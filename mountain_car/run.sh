#!/bin/bash
set -euo pipefail

# Mountain Car Control Example Runner
#
# Evolves a NEAT-AI controller that drives an under-powered car up a
# sinusoidal hill, saves the champion creature, and writes an animated
# SVG snapshot of the run to docs/screenshots/mountain_car.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🚗 Mountain Car Control Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  mountain_car/mountain_car.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/mountain_car.svg" ]]; then
  deno fmt docs/screenshots/mountain_car.svg > /dev/null
fi
if [[ -f "docs/screenshots/mountain_car_evolution.svg" ]]; then
  deno fmt docs/screenshots/mountain_car_evolution.svg > /dev/null
fi
if [[ -f "docs/screenshots/mountain_car/evolution.svg" ]]; then
  deno fmt docs/screenshots/mountain_car/evolution.svg > /dev/null
fi
