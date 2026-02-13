#!/bin/bash
set -euo pipefail

# Suggest Improvements Runner
#
# This script analyses the NEAT-AI-Examples project and outputs
# improvement suggestions. These suggestions can be filed as
# GitHub issues using the GH CLI.

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
  --allow-read \
  --allow-write \
  suggest_improvements/suggest_improvements.ts \
  "$@"
