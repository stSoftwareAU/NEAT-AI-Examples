#!/bin/bash
# Poll MNIST test accuracy and emit a wake sentinel (plus optional git check-in)
# whenever accuracy crosses a new 10% band: 50%, 60%, 70%, 80%, 90%.
#
# Usage (from repo root, while recorded_evolution_campaign.sh is running):
#   ./mnist_classification/accuracy_milestone_watcher.sh
#
# Env:
#   MNIST_MILESTONE_POLL_SECS  Poll interval (default 120)
#   MNIST_MILESTONE_GIT_CHECKIN  1 to commit docs artefacts at each band (default 1)

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

SUMMARY="${REPO_ROOT}/docs/data/mnist_classification/run_summary.json"
STATE_DIR="${REPO_ROOT}/.synthetic-mnist/exploration"
STATE_FILE="${STATE_DIR}/last_notified_milestone_pct"
LOG="${STATE_DIR}/milestone_watcher.log"
POLL_SECS="${MNIST_MILESTONE_POLL_SECS:-120}"
GIT_CHECKIN="${MNIST_MILESTONE_GIT_CHECKIN:-1}"

mkdir -p "${STATE_DIR}"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" | tee -a "${LOG}"
}

read_accuracy_pct() {
  if [[ ! -f "${SUMMARY}" ]]; then
    echo "0"
    return
  fi
  python3 - <<PY
import json
with open("${SUMMARY}") as f:
    d = json.load(f)
print(f"{d.get('testAccuracy', 0) * 100:.4f}")
PY
}

read_last_notified() {
  if [[ -f "${STATE_FILE}" ]]; then
    cat "${STATE_FILE}"
  else
    python3 - <<PY
acc = float("$(read_accuracy_pct)")
band = int(acc // 10) * 10
print(band)
PY
  fi
}

milestone_band() {
  python3 - <<PY
acc = float("$1")
print(int(acc // 10) * 10)
PY
}

git_check_in() {
  local band="$1"
  local acc="$2"
  if [[ "${GIT_CHECKIN}" != "1" ]]; then
    return 0
  fi
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    log "git check-in skipped — not a git repo"
    return 0
  fi
  local paths=(
    docs/data/mnist_classification
    docs/screenshots/mnist_classification.svg
    docs/screenshots/mnist_classification
  )
  if ! git status --porcelain -- "${paths[@]}" | grep -q .; then
    log "git check-in skipped — no artefact changes at ${band}%"
    return 0
  fi
  git add "${paths[@]}"
  git commit -m "$(cat <<EOF
MNIST milestone: ${band}% test accuracy band (${acc}% measured)

Recorded-evolution campaign checkpoint — champion, milestones, and charts
updated after crossing the ${band}% hold-out accuracy band.
EOF
)" && log "git check-in committed for ${band}% band (${acc}%)"
}

log "=== MNIST accuracy milestone watcher === poll=${POLL_SECS}s git_checkin=${GIT_CHECKIN}"
last="$(read_last_notified)"
log "Starting from last notified band: ${last}% (current accuracy $(read_accuracy_pct)%)"

while true; do
  acc="$(read_accuracy_pct)"
  band="$(milestone_band "${acc}")"

  if [[ "${band}" -gt "${last}" && "${band}" -ge 50 ]]; then
    log "🎯 Milestone crossed: ${band}% band — test accuracy ${acc}%"
    git_check_in "${band}" "${acc}"
    echo "${band}" > "${STATE_FILE}"
    last="${band}"
    echo "AGENT_LOOP_WAKE_MNIST_MILESTONE {\"prompt\":\"MNIST test accuracy reached the ${band}% band (${acc}%). Summarise campaign progress from run_summary.json, milestones.json, and campaign_record.json, then confirm the milestone watcher is still running for the next band.\",\"band\":${band},\"accuracy\":\"${acc}\"}"
  fi

  if python3 - <<PY
acc=float("${acc}")
import sys
sys.exit(0 if acc >= 90.0 else 1)
PY
  then
    log "Target 90% reached (${acc}%) — watcher exiting."
    echo "AGENT_LOOP_WAKE_MNIST_MILESTONE {\"prompt\":\"MNIST reached ${acc}% test accuracy (≥90% target). Summarise final campaign results and stop the milestone watcher if still running.\",\"band\":90,\"accuracy\":\"${acc}\"}"
    exit 0
  fi

  if ! pgrep -f "recorded_evolution_campaign.sh|exploration_campaign.ts" >/dev/null 2>&1; then
    log "Campaign process not running — watcher exiting (last accuracy ${acc}%)."
    exit 0
  fi

  sleep "${POLL_SECS}"
done
