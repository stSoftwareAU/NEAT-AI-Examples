#!/bin/bash
# Shared preamble sourced by every example run.sh — sets up Discovery
# (runlib), the native rust_scorer, training read mode, and Deno flags.
#
# Requires REPO_ROOT to be set and cwd to be REPO_ROOT before sourcing.
# Optional: set NEAT_EXAMPLES_MAX_HEAP_MB before sourcing (default 4096).

if [[ -z "${REPO_ROOT:-}" ]]; then
  echo "example_runner_preamble.sh: REPO_ROOT must be set" >&2
  exit 1
fi

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

COMMON_DIR="${REPO_ROOT}/common"

# shellcheck source=common/ensure_neat_ai_discovery.sh
source "${COMMON_DIR}/ensure_neat_ai_discovery.sh"
# shellcheck source=common/ensure_neat_ai_native_scorer.sh
source "${COMMON_DIR}/ensure_neat_ai_native_scorer.sh"

export NEAT_TRAINING_READ_SEQUENTIAL="${NEAT_TRAINING_READ_SEQUENTIAL:-1}"

ensure_neat_ai_discovery
ensure_neat_ai_native_scorer
rust_scorer_allow_run_args

MAX_HEAP_SIZE="${NEAT_EXAMPLES_MAX_HEAP_MB:-4096}"

export NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP,NEAT_TRAINING_READ_SEQUENTIAL,NEAT_AI_RUST_SCORER_ENABLED,NEAT_AI_RUST_SCORER_BINARY_PATH"

# Base Deno permission flags shared by every example (issue #419 scoped policy).
NEAT_EXAMPLE_ALLOW_SYS="--allow-sys=systemMemoryInfo,hostname"
export NEAT_EXAMPLE_DENO_FLAGS=(
  --no-prompt
  --v8-flags=--max-old-space-size="${MAX_HEAP_SIZE}"
  --unstable-worker-options
  --allow-read
  --allow-write
  --allow-import
  --allow-ffi
  "${NEAT_EXAMPLE_ALLOW_SYS}"
)
