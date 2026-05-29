#!/bin/bash
set -euo pipefail

# MNIST recorded-evolution campaign — GRQ-style sampled evolution,
# full-data polish, optional intelligent-design squash scan. Every phase
# is persisted under docs/data/mnist_classification/ immediately.
# Scratch state lives under .synthetic-mnist/exploration/ (gitignored).
#
# Usage (from repo root):
#   ./mnist_classification/exploration_campaign.sh
#   ./mnist_classification/exploration_campaign.sh --fresh
#   ./mnist_classification/exploration_campaign.sh --loop-minutes=75 --repeats=1
#   ./mnist_classification/exploration_campaign.sh --sample-rate=0.01 --loop-minutes=60
#   ./mnist_classification/exploration_campaign.sh --squash-scan
#   ./mnist_classification/exploration_campaign.sh --skip-id
#
# Hidden repeat runner (gitignored):
#   ./.synthetic-mnist/exploration/repeat_fresh_campaign.sh
#
# For an overnight loop until a target accuracy, use recorded_evolution_campaign.sh
# (it appends to .synthetic-mnist/exploration/overnight.log itself — do not wrap
# the shell script in an extra `>> overnight.log` redirect).
#
# Env:
#   NEAT_EXAMPLES_MAX_HEAP_MB  Deno heap (default 12288)
#   MNIST_LOOP_MINUTES         Target loop wall-clock (default 60)
#   MNIST_LOOP_REPEATS         Repeats of structure-1…4 + polish (default 2)

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

export NEAT_EXAMPLES_MAX_HEAP_MB="${NEAT_EXAMPLES_MAX_HEAP_MB:-12288}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🔬 MNIST exploration campaign (sampled evolution + optional ID pass)"
echo ""

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},NEAT_EXAMPLES_MAX_HEAP_MB,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=storage.googleapis.com,jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  mnist_classification/exploration_campaign.ts \
  "$@"
