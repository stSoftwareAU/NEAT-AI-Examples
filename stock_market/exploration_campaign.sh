#!/bin/bash
# Stock-Market phased exploration campaign (issue #476).
#
# Runs the structure → polish phase schedule defined in
# `exploration_campaign.ts` against the public S&P 500 monthly-close
# dataset. All artefacts land under `.synthetic-stock/exploration/`
# (hidden, gitignored). Pass `--promote` to copy the champion + summary
# into `docs/data/stock_market/exploration/`.
#
# Usage:
#   ./stock_market/exploration_campaign.sh              # full campaign, no promote
#   ./stock_market/exploration_campaign.sh --fast       # tiny smoke test
#   ./stock_market/exploration_campaign.sh --promote    # promote artefacts
#   ./stock_market/exploration_campaign.sh --squash-scan --promote
#
# ⚠️ Teaching example only — not investment advice.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "📈 Stock Market — phased exploration campaign"
echo ""

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},STOCK_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=raw.githubusercontent.com,jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  stock_market/exploration_campaign_cli.ts \
  "$@"
