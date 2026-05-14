#!/bin/bash
set -euo pipefail

# Adaptive Mutation Rate Demo Runner (issue #86, audited #212)
#
# Evolves a NEAT-AI creature from a minimal seed (input + output
# counts only) over a binary `.bin` regression task, captures
# per-generation telemetry, and writes the headline SVG plus the
# fitness and topology charts.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Adaptive Mutation Rate Demo"
echo ""

deno run \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  --allow-run \
  adaptive_mutation/adaptive_mutation.ts \
  "$@"
