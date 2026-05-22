#!/bin/bash
set -euo pipefail

# CRISPR Gene Injection Example Runner
#
# Builds a binary training set from a hand-crafted target, runs two
# minimal-seed `Creature.evolveDir` phases (before and after splicing
# the hand-crafted gene), and renders a single SVG with the gene
# topology on top and a before-vs-after milestone summary panel below.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧬 CRISPR Gene Injection Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},CRISPR_QUICK" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  crispr_injection/crispr_injection.ts \
  "$@"
