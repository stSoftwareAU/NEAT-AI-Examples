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

# `LUNAR_QUICK=1` (or `--quick`) forces the runner into the CI/quality
# fast path: tiny iterations cap, no canonical-artefact writes, so
# quality.sh stays inside its tight per-section budget without
# overwriting the docs SVGs checked into the repo.
deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  lunar_lander/lunar_lander.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderers emit compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines. Quick mode
# routes its writes to a temp directory, so the existence guards skip
# cleanly when canonical artefacts were not regenerated.
if [[ -f "docs/screenshots/lunar_lander.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander.svg > /dev/null
fi
if [[ -f "docs/screenshots/lunar_lander/milestones.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander/milestones.svg > /dev/null
fi
if [[ -f "docs/screenshots/lunar_lander/complexity.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander/complexity.svg > /dev/null
fi
if [[ -f "docs/screenshots/lunar_lander/validation.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander/validation.svg > /dev/null
fi
# Multi-run chart artefacts written by `runMultiRunLunarLander` (issue #344).
if [[ -f "docs/screenshots/lunar_lander/milestones.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander/milestones.svg > /dev/null
fi
if [[ -f "docs/screenshots/lunar_lander/complexity.svg" ]]; then
  deno fmt docs/screenshots/lunar_lander/complexity.svg > /dev/null
fi
