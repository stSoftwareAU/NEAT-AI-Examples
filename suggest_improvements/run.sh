#!/bin/bash
set -euo pipefail

# Suggest Improvements Runner
#
# Analyses the NEAT-AI-Examples project and outputs improvement
# suggestions, then runs the audit-#219 minimal-seed `evolveDir`
# stage that genuinely exercises NEAT-AI on a synthetic regression
# task derived from the suggested improvements. The suggestions can
# be filed as GitHub issues using the GH CLI.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "Suggest Improvements"

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},SUGGEST_QUICK" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  suggest_improvements/suggest_improvements.ts \
  "$@"
