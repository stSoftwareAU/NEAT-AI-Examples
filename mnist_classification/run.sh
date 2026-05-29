#!/bin/bash
set -euo pipefail

# MNIST Handwritten-Digit Classification Example Runner
#
# Writes the FULL 60 000-record MNIST training set to a binary `.bin`
# file and runs `Creature.evolveDir(dataDir, { targetError, timeoutMinutes })`
# over that directory. On the first run (no saved champion) NEAT-AI builds
# the seed via the data-derived factory `Creature.forDataset(records,
# { cost: "CROSS_ENTROPY" })` (issues #518 + #523) — SOFTMAX outputs,
# factory-sized hidden layer, dead-pixel pruning. Training/selection uses
# softmax + cross-entropy (the standard differentiable multi-class cost);
# top-1 argmax accuracy is still reported but no longer drives evolution.
# Every subsequent invocation reloads the persisted champion and continues
# evolution. Persists the champion and a per-run milestone via the
# multi-run helper (issue #327). Renders the prediction-grid SVG plus both
# multi-run charts.
#
# `--allow-ffi` is required so NEAT-AI can load the Rust Discovery library
# (structural growth) and the full evolveDir training pipeline.
#
# Recognised flags (forwarded verbatim to the Deno program):
#   --timeout=<minutes>  Override the wall-clock budget (default 5).
#   --fresh              Discard saved champion + history (use sparingly).
#
# Network access is required on the first run to download the gzipped
# IDX files into .synthetic-mnist/data/; subsequent runs use the cached
# copies.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🔢 MNIST Handwritten-Digit Classification Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},MNIST_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=storage.googleapis.com,jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  mnist_classification/mnist_classification.ts \
  "$@"
