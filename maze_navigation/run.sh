#!/bin/bash
set -euo pipefail

# Maze Navigation Example Runner
#
# Evolves a NEAT-AI controller that navigates a fixed grid maze from a
# start cell to a goal cell using local sensor inputs (wall distances
# plus a packed heading-to-goal). Saves the champion creature, the
# trajectory log, and writes an animated SVG of the champion's run to
# docs/screenshots/maze_navigation.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🗺️  Maze Navigation Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  maze_navigation/maze_navigation.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/maze_navigation.svg" ]]; then
  deno fmt docs/screenshots/maze_navigation.svg > /dev/null
fi
if [[ -f "docs/screenshots/maze_navigation_milestones.svg" ]]; then
  deno fmt docs/screenshots/maze_navigation_milestones.svg > /dev/null
fi
