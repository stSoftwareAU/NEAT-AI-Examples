#!/bin/bash
set -euo pipefail

# Discovery-at-Scale Demo Runner (issue #84)
#
# Builds a deterministic large creature (~200 hidden neurons), injects a
# mix of structural defects (saturated, dead, dormant, dormant synapses,
# bottleneck), runs Creature.discoveryDir to attempt recovery, prints
# baseline / crippled / discovered scores plus a defect tally, and
# renders the before/after topology SVG to:
#
#   .discovery-at-scale/output/discovery_at_scale.svg
#   docs/screenshots/discovery_at_scale.svg
#
# Discovery is wrapped in try/catch in the demo — if the underlying
# NEAT-AI-Discovery FFI library is unavailable, the rest of the pipeline
# (scoring, defect detection, SVG rendering) still runs.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🔬 Discovery-at-Scale Demo"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  discovery_at_scale/discovery_at_scale.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean.
if [[ -f "docs/screenshots/discovery_at_scale.svg" ]]; then
  deno fmt docs/screenshots/discovery_at_scale.svg > /dev/null
fi
if [[ -f ".discovery-at-scale/output/discovery_at_scale.svg" ]]; then
  deno fmt .discovery-at-scale/output/discovery_at_scale.svg > /dev/null
fi
