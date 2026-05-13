#!/bin/bash
set -euo pipefail

# Snake Game Example Runner
#
# Evolves a NEAT-AI controller that plays the classic Snake grid game
# via Creature.evolveRL(), saves the champion creature, and writes an
# animated SVG of the champion's playthrough plus the milestone chart.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🐍 Snake Game Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  snake_game/snake_game.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderers emit compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/snake_game.svg" ]]; then
  deno fmt docs/screenshots/snake_game.svg > /dev/null
fi
if [[ -f "docs/screenshots/snake_game/milestones.svg" ]]; then
  deno fmt docs/screenshots/snake_game/milestones.svg > /dev/null
fi
if [[ -f "docs/screenshots/snake_game/complexity.svg" ]]; then
  deno fmt docs/screenshots/snake_game/complexity.svg > /dev/null
fi
