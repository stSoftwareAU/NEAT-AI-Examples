#!/bin/bash
set -euo pipefail

# CRISPR Gene Injection Example Runner
#
# Builds a baseline population on a synthetic two-input task, evolves it
# until fitness plateaus, splices a hand-crafted "edit gene" (two TANH
# hidden neurons + their synapses) into the top members, and continues
# evolving. Renders a single SVG with the gene topology in the top panel
# and the fitness-vs-generation curve (with an injection marker) below.

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

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/crispr_injection.svg" ]]; then
  deno fmt docs/screenshots/crispr_injection.svg > /dev/null
fi
