#!/bin/bash
set -euo pipefail

# Evolution Showcase Example Runner — long-running flagship.
#
# Evolves a NEAT-AI controller for ~10000 generations against a
# deterministic non-linear regression task, captures snapshots at
# generations 1, 10, 100, 1000, and 10000, and renders the result as
# a multi-panel SVG strip in docs/screenshots/evolution_showcase_evolution.svg.
#
# This run is deliberately long (typically minutes-to-tens-of-minutes
# on a developer machine) and is **not** part of `quality.sh`.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Evolution Showcase Example (long-running flagship)"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  evolution_showcase/evolution_showcase.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/evolution_showcase_evolution.svg" ]]; then
  deno fmt docs/screenshots/evolution_showcase_evolution.svg > /dev/null
fi
