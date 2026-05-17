#!/bin/bash
set -euo pipefail

# MNIST Handwritten-Digit Classification Example Runner
#
# Writes the FULL 60 000-record MNIST training set to a binary `.bin`
# file, seeds NEAT-AI with `new Creature(784, 10)` (no hidden hint, no
# warm start) on the first run, and runs `Creature.evolveDir(dataDir,
# { targetError, timeoutMinutes })` exactly once. Persists the champion
# and a per-run milestone via the multi-run helper (issue #327) so
# subsequent invocations resume from the saved creature and append a
# fresh milestone to the merged history. Renders the prediction-grid
# SVG plus both multi-run charts (milestones.svg + complexity.svg).
#
# Recognised flags (forwarded verbatim to the Deno program):
#   --fresh                 Wipe prior multi-run state before running.
#   --timeout=<minutes>     Override the wall-clock budget (default 5).
#   --target-error=<value>  Override the early-exit threshold (default 0.001).
#
# Network access is required on the first run to download the gzipped
# IDX files into .synthetic-mnist/data/; subsequent runs use the cached
# copies.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🔢 MNIST Handwritten-Digit Classification Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to the MNIST dataset host (storage.googleapis.com) and jsr.io
# in case JSR module loading happens at runtime; no spawned subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},MNIST_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=storage.googleapis.com,jsr.io \
  mnist_classification/mnist_classification.ts \
  "$@"
