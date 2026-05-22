#!/bin/bash
set -euo pipefail

# Discovery-at-Scale Demo Runner (issue #84)
#
# Builds a deterministic large creature (~200 hidden neurons), injects a
# mix of structural defects (saturated, dead, dormant, dormant synapses,
# bottleneck), runs Creature.discoveryDir to attempt recovery, prints
# baseline / crippled / discovered scores plus a defect tally, and
# renders the before/after topology SVG to:
#
#   .discovery-at-scale/output/discovery_at_scale.svg
#   docs/screenshots/discovery_at_scale.svg
#
# Discovery is wrapped in try/catch in the demo — if the underlying
# NEAT-AI-Discovery FFI library is unavailable, the rest of the pipeline
# (scoring, defect detection, SVG rendering) still runs.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🔬 Discovery-at-Scale Demo"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  discovery_at_scale/discovery_at_scale.ts \
  "$@"
