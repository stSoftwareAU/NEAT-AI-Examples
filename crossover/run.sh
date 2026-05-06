#!/bin/bash
set -euo pipefail

# Crossover (Breeding) Example Runner
#
# This script demonstrates the crossover (breeding) workflow.
# It creates two parent creatures with different architectures,
# breeds them to produce offspring, and compares performance.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Crossover (Breeding) Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  --allow-run \
  crossover/crossover_example.ts \
  "$@"
