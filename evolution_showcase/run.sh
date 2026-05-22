#!/bin/bash
set -euo pipefail

# Evolution Showcase Example Runner — minimal-seed evolution + milestone
# summary (issue #211, telemetry rewired under #301).
#
# Builds a hand-crafted teacher creature, synthesises a deterministic
# binary `.bin` training set from it, evolves a minimal NEAT-AI seed
# (`new Creature(INPUT, OUTPUT)`) via `Creature.evolveDir` until either
# the per-example `targetError` is reached or the wall-clock backstop
# fires (20 minutes per issue #377, Refresh-2026-05), and renders a
# single milestone summary SVG built from the call's return value:
#
#   - docs/screenshots/evolution_showcase/evolution_summary.svg
#
# The example is **not** part of `quality.sh`. Runtime is roughly tens
# of seconds on a developer laptop with the default configuration.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧬 Evolution Showcase Example (minimal-seed evolution, issue #211)"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  evolution_showcase/evolution_showcase.ts \
  "$@"
