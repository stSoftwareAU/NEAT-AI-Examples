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

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "📈 Stock-Market Direction Prediction Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to the S&P 500 dataset host (raw.githubusercontent.com) and
# jsr.io in case JSR module loading happens at runtime.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},STOCK_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=raw.githubusercontent.com,jsr.io \
  stock_market/stock_market.ts \
  "$@"
