#!/bin/bash
set -euo pipefail

# Regenerate docs/ MNIST charts + prediction-grid SVG from persisted state.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

export NEAT_EXAMPLES_MAX_HEAP_MB="${NEAT_EXAMPLES_MAX_HEAP_MB:-12288}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},NEAT_EXAMPLES_MAX_HEAP_MB,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=storage.googleapis.com,jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  mnist_classification/regenerate_recorded_artefacts.ts \
  "$@"
