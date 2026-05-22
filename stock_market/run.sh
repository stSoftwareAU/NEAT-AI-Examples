#!/bin/bash
set -euo pipefail

# Stock-Market Direction Prediction Example Runner
#
# Evolves a NEAT-AI controller that predicts next-period direction
# (up/down) on the public S&P 500 monthly-close dataset, saves the
# champion creature, writes a per-day signal log, and renders:
#
#   - docs/screenshots/stock_market.svg
#   - docs/screenshots/stock_market/milestones.svg
#     (multi-run error-curve chart — error vs cumulative generation)
#   - docs/screenshots/stock_market/complexity.svg
#     (multi-run complexity chart — neurons + synapses vs cumulative
#     generation)
#
# Multi-run flags (forwarded verbatim — issue #328):
#   --fresh                 wipe prior creature, milestones, and both chart SVGs
#   --timeout=<minutes>     wall-clock budget for this invocation (default 5)
#   --target-error=<value>  early-exit threshold (default 0.01)
#
# ⚠️ Teaching example only — not investment advice.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "📈 Stock-Market Direction Prediction Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},STOCK_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=raw.githubusercontent.com,jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  stock_market/stock_market.ts \
  "$@"
