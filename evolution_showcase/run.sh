#!/bin/bash
set -euo pipefail

# Evolution Showcase Example Runner — minimal-seed evolution + telemetry (issue #211).
#
# Builds a hand-crafted teacher creature, synthesises a deterministic
# binary `.bin` training set from it, evolves a minimal NEAT-AI seed
# (`new Creature(INPUT, OUTPUT)`) via `Creature.evolveDir` until either
# the per-example `targetError` is reached or the `timeoutMinutes: 5`
# backstop fires, captures per-generation telemetry, and emits the
# audit-mandated CSV plus three SVG charts:
#
#   - docs/data/evolution_showcase/evolution.csv       (per-generation rows)
#   - docs/screenshots/evolution_showcase/fitness.svg  (best vs mean fitness)
#   - docs/screenshots/evolution_showcase/topology.svg (score / neurons / synapses)
#   - docs/screenshots/evolution_showcase_evolution.svg (multi-panel snapshot strip)
#
# The example is **not** part of `quality.sh`. Runtime is roughly tens
# of seconds on a developer laptop with the default configuration.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Evolution Showcase Example (minimal-seed evolution, issue #211)"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  evolution_showcase/evolution_showcase.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderers emit compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
for svg in \
  "docs/screenshots/evolution_showcase_evolution.svg" \
  "docs/screenshots/evolution_showcase/fitness.svg" \
  "docs/screenshots/evolution_showcase/topology.svg"; do
  if [[ -f "${svg}" ]]; then
    deno fmt "${svg}" > /dev/null
  fi
done
