#!/bin/bash
set -euo pipefail

# Overnight MNIST recorded-evolution loop.
#
# Runs one exploration loop per invocation (~60 min by default: two repeats
# of structure-1…4 + polish). Structure phases fill their timeout; polish
# is capped at two full-data generations. Re-run without --fresh to continue.
# milestones, campaign_record.json, and all charts, then re-record from
# scratch.
#
# Usage:
#   ./mnist_classification/recorded_evolution_campaign.sh --fresh --hidden-seed
#   ./mnist_classification/recorded_evolution_campaign.sh
#
# Env:
#   MNIST_TARGET_ACCURACY     Stop when test accuracy reaches this (default 0.90)
#   MNIST_CAMPAIGN_MAX_HOURS  Wall-clock budget (default 48)
#   MNIST_LOOP_MINUTES        Target minutes per loop (default 60)
#   MNIST_LOOP_REPEATS        Repeats of structure-1…4 + polish (default 2)
#   NEAT_EXAMPLES_MAX_HEAP_MB Deno heap (default 12288)

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

export NEAT_EXAMPLES_MAX_HEAP_MB="${NEAT_EXAMPLES_MAX_HEAP_MB:-12288}"
TARGET="${MNIST_TARGET_ACCURACY:-0.90}"
MAX_HOURS="${MNIST_CAMPAIGN_MAX_HOURS:-48}"
LOOP_MINUTES="${MNIST_LOOP_MINUTES:-60}"
LOOP_REPEATS="${MNIST_LOOP_REPEATS:-2}"
SUMMARY="${REPO_ROOT}/docs/data/mnist_classification/run_summary.json"
LOG="${REPO_ROOT}/.synthetic-mnist/exploration/overnight.log"
mkdir -p "$(dirname "${LOG}")"

LOOP_ARGS=(--loop-minutes="${LOOP_MINUTES}" --repeats="${LOOP_REPEATS}")

FRESH_ARGS=()
if [[ "${1:-}" == "--fresh" ]]; then
  FRESH_ARGS=(--fresh)
  shift
  if [[ "${1:-}" == "--hidden-seed" ]]; then
    FRESH_ARGS+=(--hidden-seed)
    shift
  fi
fi

START_EPOCH=$(date +%s)
DEADLINE=$((START_EPOCH + MAX_HOURS * 3600))
CYCLE=0

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" | tee -a "${LOG}"
}

accuracy() {
  if [[ ! -f "${SUMMARY}" ]]; then
    echo "0"
    return
  fi
  python3 - <<PY
import json
with open("${SUMMARY}") as f:
    d=json.load(f)
print(d.get("testAccuracy", 0))
PY
}

log "=== MNIST recorded-evolution overnight campaign ==="
log "target_accuracy=${TARGET} max_hours=${MAX_HOURS} loop_minutes=${LOOP_MINUTES} repeats=${LOOP_REPEATS}"

while [[ $(date +%s) -lt ${DEADLINE} ]]; do
  CYCLE=$((CYCLE + 1))
  ACC="$(accuracy)"
  log "Cycle ${CYCLE} starting (test accuracy ${ACC})"

  if python3 - <<PY
acc=float("${ACC}")
target=float("${TARGET}")
import sys
sys.exit(0 if acc >= target else 1)
PY
  then
    log "Target accuracy ${TARGET} reached — stopping."
    break
  fi

  if [[ ${CYCLE} -eq 1 && ${#FRESH_ARGS[@]} -gt 0 ]]; then
    ./mnist_classification/exploration_campaign.sh "${FRESH_ARGS[@]}" "${LOOP_ARGS[@]}" "$@" 2>&1 | tee -a "${LOG}"
  else
    ./mnist_classification/exploration_campaign.sh "${LOOP_ARGS[@]}" "$@" 2>&1 | tee -a "${LOG}"
  fi

  ACC="$(accuracy)"
  log "Cycle ${CYCLE} complete — test accuracy ${ACC}"
done

log "Campaign finished after ${CYCLE} cycle(s). Final test accuracy $(accuracy)."
