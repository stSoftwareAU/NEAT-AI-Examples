#!/bin/bash
set -euo pipefail

# Suggest Improvements Runner
#
# Analyses the NEAT-AI-Examples project and outputs improvement
# suggestions, then runs the audit-#219 minimal-seed `evolveDir`
# stage that genuinely exercises NEAT-AI on a synthetic regression
# task derived from the suggested improvements. The suggestions can
# be filed as GitHub issues using the GH CLI.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "Suggest Improvements"
echo "   Analysing project for improvement opportunities"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  suggest_improvements/suggest_improvements.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
for svg in \
  "docs/screenshots/suggest_improvements/fitness.svg" \
  "docs/screenshots/suggest_improvements/topology.svg"; do
  if [[ -f "${svg}" ]]; then
    deno fmt "${svg}" > /dev/null
  fi
done
