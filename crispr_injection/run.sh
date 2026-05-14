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

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  crispr_injection/crispr_injection.ts \
  "$@"
