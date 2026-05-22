#!/bin/bash
set -euo pipefail

# Adaptive Mutation Rate Demo Runner (issue #86, audited #212)
#
# Evolves a NEAT-AI creature from a minimal seed (input + output
# counts only) over a binary `.bin` regression task, captures
# per-generation telemetry, and writes the headline SVG plus the
# fitness and topology charts.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧬 Adaptive Mutation Rate Demo"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  adaptive_mutation/adaptive_mutation.ts \
  "$@"
