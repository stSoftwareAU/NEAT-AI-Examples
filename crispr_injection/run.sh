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

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 CRISPR Gene Injection Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch in
# @stsoftware/neat-ai; no spawned subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},CRISPR_QUICK" \
  --allow-net=jsr.io \
  --allow-ffi \
  crispr_injection/crispr_injection.ts \
  "$@"
