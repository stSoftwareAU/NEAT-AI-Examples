#!/bin/bash
# MNIST evolution campaign — 15-minute chunks, factory-derived fresh seed.
#
# Usage (from repo root):
#   ./mnist_classification/overnight_campaign.sh
#
# First run uses `--fresh` (factory seed) unless MNIST_CAMPAIGN_SKIP_FRESH=1.
# Override duration: MNIST_CAMPAIGN_MAX_HOURS=4 MNIST_CAMPAIGN_RUN_MINUTES=15
#
# Logs: .synthetic-mnist/overnight/campaign.log
# Stats: .synthetic-mnist/overnight/stats.tsv

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

RUN_MINUTES="${MNIST_CAMPAIGN_RUN_MINUTES:-15}"
MAX_HOURS="${MNIST_CAMPAIGN_MAX_HOURS:-4}"
MAX_RUNS="${MNIST_CAMPAIGN_MAX_RUNS:-$(( MAX_HOURS * 60 / RUN_MINUTES ))}"
SKIP_FRESH="${MNIST_CAMPAIGN_SKIP_FRESH:-0}"

LOG_DIR="${REPO_ROOT}/.synthetic-mnist/overnight"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/campaign.log"
STATS="${LOG_DIR}/stats.tsv"
ISSUES="${LOG_DIR}/issues_raised.txt"
touch "${ISSUES}"

SUMMARY="${REPO_ROOT}/docs/data/mnist_classification/run_summary.json"

export NEAT_EXAMPLES_MAX_HEAP_MB="${NEAT_EXAMPLES_MAX_HEAP_MB:-12288}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for overnight monitoring" >&2
  exit 1
fi

raise_issue_once() {
  local key="$1"
  local title="$2"
  local body="$3"
  if grep -qxF "${key}" "${ISSUES}" 2>/dev/null; then
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "[monitor] gh not available — would file issue: ${title}" | tee -a "${LOG}"
    return 0
  fi
  local url
  url="$(gh issue create --title "${title}" --body "${body}" 2>&1)" || {
    echo "[monitor] gh issue create failed: ${url}" | tee -a "${LOG}"
    return 0
  }
  echo "${key}" >> "${ISSUES}"
  echo "[monitor] filed ${url}" | tee -a "${LOG}"
}

scan_log_for_footguns() {
  local run="$1"
  local slice="${LOG_DIR}/run_${run}.log"
  tail -n 4000 "${LOG}" > "${slice}" || true

  if grep -q "FFI permission denied" "${slice}"; then
    raise_issue_once "ffi-denied" \
      "MNIST overnight: FFI permission denied for Discovery library" \
      "Run ${run} log shows FFI permission denied. Check \`run.sh\` passes \`--allow-ffi\` and \`example_runner_preamble.sh\` runs \`ensure_neat_ai_discovery\`."
  fi
  if grep -q "discards the saved champion" "${slice}" && [[ "${run}" -ne 1 || ${SKIP_FRESH} -ne 0 ]]; then
    raise_issue_once "fresh-used" \
      "MNIST overnight: --fresh detected during campaign" \
      "Run ${run} invoked with \`--fresh\`, wiping persisted progress."
  fi
  if grep -q "Quick mode (MNIST_QUICK=1)" "${slice}"; then
    raise_issue_once "quick-mode" \
      "MNIST overnight: MNIST_QUICK=1 detected during campaign" \
      "Run ${run} used quick mode — results are not representative."
  fi
  if grep -q "NEAT-AI-Discovery not found" "${slice}"; then
    raise_issue_once "discovery-missing" \
      "MNIST overnight: NEAT-AI-Discovery sibling repo missing" \
      "Rust Discovery was skipped. Clone \`NEAT-AI-Discovery\` as a sibling of this repo and re-run."
  fi
}

record_stats() {
  local run="$1"
  local exit_code="$2"
  local prev_error="${3:-}"

  if [[ ! -f "${SUMMARY}" ]]; then
    raise_issue_once "no-summary" \
      "MNIST overnight: run_summary.json missing after run ${run}" \
      "Expected ${SUMMARY} after run ${run} (exit ${exit_code})."
    return 1
  fi

  local error test_acc val_acc neurons synapses seed_neurons stop resumed duration_s
  error="$(jq -r '.evolveDirError // empty' "${SUMMARY}")"
  test_acc="$(jq -r '.testAccuracy // empty' "${SUMMARY}")"
  val_acc="$(jq -r '.validationAccuracy // empty' "${SUMMARY}")"
  neurons="$(jq -r '.finalNeurons // empty' "${SUMMARY}")"
  seed_neurons="$(jq -r '.seedNeurons // empty' "${SUMMARY}")"
  synapses="$(jq -r '.finalSynapses // empty' "${SUMMARY}")"
  stop="$(jq -r '.stopCondition // empty' "${SUMMARY}")"
  resumed="$(jq -r '.resumed // empty' "${SUMMARY}")"
  duration_s="$(jq -r '(.evolveWallClockMs / 1000) | floor' "${SUMMARY}")"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${run}" "$(date -Iseconds)" "${duration_s}" "${error}" "${test_acc}" \
    "${val_acc}" "${neurons}" "${synapses}" "${stop}" "${resumed}" >> "${STATS}"

  echo "[stats] run=${run} error=${error} test=${test_acc} seed_neurons=${seed_neurons} neurons=${neurons} synapses=${synapses} stop=${stop}" | tee -a "${LOG}"

  if [[ "${run}" -eq 1 && "${SKIP_FRESH}" -eq 1 && "${resumed}" != "true" ]]; then
    raise_issue_once "not-resumed" \
      "MNIST overnight: first campaign run did not resume saved champion" \
      "Expected \`resumed: true\` in run_summary.json but got \`${resumed}\`. Prior champion may have been lost."
  fi

  if [[ -n "${seed_neurons}" && "${neurons}" == "${seed_neurons}" && "${run}" -ge 3 ]]; then
    raise_issue_once "neurons-flat-${seed_neurons}" \
      "MNIST overnight: neuron count stuck at seed size ${seed_neurons} after ${run} runs" \
      "Topology may not be growing. Latest error=${error}, test accuracy=${test_acc}. See ${LOG}."
  fi

  if [[ -n "${prev_error}" && -n "${error}" ]]; then
    local improved
    improved="$(awk -v a="${prev_error}" -v b="${error}" 'BEGIN { print (b < a - 0.0001) ? 1 : 0 }')"
    if [[ "${improved}" -eq 0 && "${run}" -ge 4 ]]; then
      local stuck
      stuck="$(awk -v e="${error}" 'BEGIN { print (e > 0.05) ? 1 : 0 }')"
      if [[ "${stuck}" -eq 1 ]]; then
        raise_issue_once "error-plateau" \
          "MNIST overnight: training error plateau above 0.05 after ${run} runs" \
          "Error has not meaningfully improved since run 1 (prev=${prev_error}, now=${error}). Check Discovery/backprop pipeline."
      fi
    fi
  fi

  echo "${error}"
}

echo "=== MNIST overnight campaign ===" | tee "${LOG}"
echo "repo=${REPO_ROOT} run_minutes=${RUN_MINUTES} max_hours=${MAX_HOURS} max_runs=${MAX_RUNS}" | tee -a "${LOG}"
echo "fresh_hidden_seed=$([[ ${SKIP_FRESH} -eq 0 ]] && echo yes || echo no) heap_mb=${NEAT_EXAMPLES_MAX_HEAP_MB}" | tee -a "${LOG}"
echo -e "run\tstart\tduration_s\terror\ttest_acc\tval_acc\tneurons\tsynapses\tstop\tresumed" > "${STATS}"

DEADLINE=$(($(date +%s) + MAX_HOURS * 3600))
run=0
prev_error=""

while [[ $(date +%s) -lt ${DEADLINE} && ${run} -lt ${MAX_RUNS} ]]; do
  run=$((run + 1))
  echo "" | tee -a "${LOG}"
  echo "=== Run ${run}/${MAX_RUNS} $(date -Iseconds) timeout=${RUN_MINUTES}m ===" | tee -a "${LOG}"

  RUN_ARGS=(--timeout="${RUN_MINUTES}")
  if [[ ${run} -eq 1 && ${SKIP_FRESH} -eq 0 ]]; then
    RUN_ARGS=(--fresh --timeout="${RUN_MINUTES}")
  fi

  set +e
  "${REPO_ROOT}/mnist_classification/run.sh" "${RUN_ARGS[@]}" 2>&1 | tee -a "${LOG}"
  exit_code=${PIPESTATUS[0]}
  set -e

  scan_log_for_footguns "${run}"

  if [[ ${exit_code} -ne 0 ]]; then
    raise_issue_once "run-failed-${run}" \
      "MNIST overnight: run ${run} exited ${exit_code}" \
      "See ${LOG}. Stats: ${STATS}."
    echo "[monitor] run ${run} failed — stopping campaign" | tee -a "${LOG}"
    exit "${exit_code}"
  fi

  prev_error="$(record_stats "${run}" "${exit_code}" "${prev_error}")" || true

  if [[ $(date +%s) -ge ${DEADLINE} ]]; then
    echo "[monitor] deadline reached after run ${run}" | tee -a "${LOG}"
    break
  fi
done

echo "" | tee -a "${LOG}"
echo "=== Campaign complete $(date -Iseconds) runs=${run} ===" | tee -a "${LOG}"
echo "Final summary:" | tee -a "${LOG}"
jq '.' "${SUMMARY}" | tee -a "${LOG}"
