#!/usr/bin/env bash
# Alternate NEAT-AI-Lamarck and NEAT-AI-Backpropagation on the MNIST champion
# for a fixed wall-clock budget. Both optimisers use MSE (Lamarck via the
# plain rust_scorer default; Backpropagation's train loop is MSE-native).
# Promotions are still gated on held-out test accuracy, not train MSE alone.
#
# Usage (from repo root):
#   ./scripts/mnist_lamarck_backprop_campaign.sh
#
# Env:
#   MNIST_CAMPAIGN_MAX_HOURS   Wall-clock budget (default 3)
#   MNIST_LAMARCK_SLICE_SECS   Lamarck slice length (default 1200 = 20 min)
#   MNIST_BACKPROP_EPOCHS      Backprop epochs per slice (default 12)
#   MNIST_TARGET_ACCURACY      Early-stop hold-out test accuracy (default 0.90)

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

MAX_HOURS="${MNIST_CAMPAIGN_MAX_HOURS:-3}"
LAMARCK_SECS="${MNIST_LAMARCK_SLICE_SECS:-1200}"
BP_EPOCHS="${MNIST_BACKPROP_EPOCHS:-12}"
TARGET="${MNIST_TARGET_ACCURACY:-0.90}"

CREATURE="${REPO_ROOT}/docs/data/mnist_classification/creature.json"
DATA_DIR="${REPO_ROOT}/.synthetic-mnist/bin"
SUMMARY="${REPO_ROOT}/docs/data/mnist_classification/run_summary.json"
OUT="${REPO_ROOT}/.synthetic-mnist/lamarck-backprop"
LOG="${OUT}/campaign.log"
STATS="${OUT}/stats.tsv"

LAMARCK="${NEAT_AI_LAMARCK_BIN:-${REPO_ROOT}/../NEAT-AI-Lamarck/target/release/neat_ai_lamarck}"
BACKPROP="${NEAT_AI_BACKPROP_BIN:-${REPO_ROOT}/../NEAT-AI-Backpropagation/target/release/neat_ai_backpropagation}"
SCORER="${NEAT_AI_SCORER_BIN:-${REPO_ROOT}/../NEAT-AI-scorer/target/release/rust_scorer}"

mkdir -p "${OUT}"

if [[ ! -x "${LAMARCK}" ]]; then
  echo "neat_ai_lamarck not found at ${LAMARCK}" >&2
  exit 1
fi
if [[ ! -x "${BACKPROP}" ]]; then
  echo "neat_ai_backpropagation not found at ${BACKPROP}" >&2
  exit 1
fi
if [[ ! -x "${SCORER}" ]]; then
  echo "rust_scorer not found at ${SCORER}" >&2
  exit 1
fi
if [[ ! -f "${CREATURE}" ]]; then
  echo "missing champion ${CREATURE}" >&2
  exit 1
fi
if [[ ! -d "${DATA_DIR}" ]] || ! compgen -G "${DATA_DIR}"/*.bin >/dev/null; then
  echo "missing MNIST .bin under ${DATA_DIR}" >&2
  exit 1
fi

# Deno/neat-ai may print a version banner before the JSON object. Keep the
# last "{"…"}" line from mixed stdout+stderr.
json_line() {
  python3 -c '
import sys
lines = [ln.strip() for ln in sys.stdin if ln.lstrip().startswith("{")]
if not lines:
    raise SystemExit("no JSON object found in hold-out output")
print(lines[-1])
'
}

holdout() {
  # Merge stderr so the banner cannot break piping; json_line picks the object.
  deno run --allow-read --allow-write --allow-net --allow-env --allow-sys \
    "${REPO_ROOT}/scripts/mnist_holdout_score.ts" "$1" 2>&1 | json_line
}

holdout_field() {
  local field="$1"
  python3 -c "import json,sys; print(json.load(sys.stdin)['${field}'])"
}

promote_if_better() {
  local candidate="$1"
  local source="$2"
  local cmp_raw cmp_json improved before_test after_test before_val after_val
  set +e
  cmp_raw="$(
    deno run --allow-read --allow-write --allow-net --allow-env --allow-sys \
      "${REPO_ROOT}/scripts/mnist_holdout_score.ts" \
      --compare "${CREATURE}" "${candidate}" 2>&1
  )"
  local cmp_rc=$?
  set -e
  cmp_json="$(json_line <<<"${cmp_raw}")"
  before_test="$(python3 -c "import json,sys; print(json.load(sys.stdin)['before']['testAccuracy'])" <<<"${cmp_json}")"
  after_test="$(python3 -c "import json,sys; print(json.load(sys.stdin)['after']['testAccuracy'])" <<<"${cmp_json}")"
  before_val="$(python3 -c "import json,sys; print(json.load(sys.stdin)['before']['validationAccuracy'])" <<<"${cmp_json}")"
  after_val="$(python3 -c "import json,sys; print(json.load(sys.stdin)['after']['validationAccuracy'])" <<<"${cmp_json}")"
  improved="$(python3 -c "import json,sys; print('1' if json.load(sys.stdin)['improved'] else '0')" <<<"${cmp_json}")"

  echo "[promote] ${source}: test ${before_test} → ${after_test}  val ${before_val} → ${after_val}" | tee -a "${LOG}"

  if [[ "${improved}" == "1" && "${cmp_rc}" -eq 0 ]]; then
    cp "${candidate}" "${CREATURE}"
    cp "${candidate}" "${REPO_ROOT}/.synthetic-mnist/creatures/champion.json"
    python3 - <<PY
import json
from pathlib import Path
summary_path = Path("${SUMMARY}")
d = json.loads(summary_path.read_text()) if summary_path.exists() else {}
d["testAccuracy"] = float("${after_test}")
d["validationAccuracy"] = float("${after_val}")
d["backpropLamarckRefined"] = True
d["lastPromoteSource"] = "${source}"
summary_path.write_text(json.dumps(d, indent=2) + "\n")
PY
    echo "[promote] ACCEPTED → ${CREATURE}" | tee -a "${LOG}"
    return 0
  fi
  echo "[promote] rejected (no hold-out test gain)" | tee -a "${LOG}"
  return 1
}

echo "=== MNIST Lamarck + Backprop campaign (MSE) ===" | tee "${LOG}"
echo "max_hours=${MAX_HOURS} lamarck_slice=${LAMARCK_SECS}s backprop_epochs=${BP_EPOCHS} target=${TARGET} scorer=${SCORER}" | tee -a "${LOG}"
echo -e "cycle\tutc\tphase\ttest_acc\tval_acc\tpromoted" > "${STATS}"

DEADLINE=$(($(date +%s) + MAX_HOURS * 3600))
CYCLE=0

baseline="$(holdout "${CREATURE}")"
echo "[baseline] ${baseline}" | tee -a "${LOG}"

while [[ "$(date +%s)" -lt "${DEADLINE}" ]]; do
  CYCLE=$((CYCLE + 1))
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  remaining=$((DEADLINE - $(date +%s)))
  echo "" | tee -a "${LOG}"
  echo "[cycle ${CYCLE}] remaining≈${remaining}s @ ${now}" | tee -a "${LOG}"

  # ---- Lamarck slice ----
  slice_budget="${LAMARCK_SECS}"
  if [[ "${remaining}" -lt "${slice_budget}" ]]; then
    slice_budget="${remaining}"
  fi
  if [[ "${slice_budget}" -lt 60 ]]; then
    echo "[stop] less than 60s left before Lamarck slice" | tee -a "${LOG}"
    break
  fi

  lamarck_out="${OUT}/lamarck_${CYCLE}"
  mkdir -p "${lamarck_out}"
  echo "[lamarck] timeout=${slice_budget}s → ${lamarck_out}" | tee -a "${LOG}"
  set +e
  # Plain rust_scorer defaults to MSE, matching Lamarck's Phase-0 local
  # parity check and NEAT-AI-Backpropagation's train loop.
  "${LAMARCK}" \
    "${CREATURE}" \
    "${DATA_DIR}" \
    --scorer "${SCORER}" \
    --output-dir "${lamarck_out}" \
    --timeout-seconds "${slice_budget}" \
    --candidates 80 \
    --scale-candidate-quotas \
    --focus-count 3 \
    --focus-policy weighted \
    --screen-sample-rate 0.05 \
    --quick \
    --quick-sample-records 12000 \
    --backprop-learning-rate 0.001 \
    --seed "${CYCLE}" \
    >>"${LOG}" 2>&1
  lamarck_rc=$?
  set -e
  echo "[lamarck] exit=${lamarck_rc}" | tee -a "${LOG}"

  promoted=0
  if [[ -f "${lamarck_out}/best.json" ]]; then
    if promote_if_better "${lamarck_out}/best.json" "lamarck-${CYCLE}"; then
      promoted=1
    fi
  else
    echo "[lamarck] no best.json written" | tee -a "${LOG}"
  fi

  acc_json="$(holdout "${CREATURE}")"
  test_acc="$(holdout_field testAccuracy <<<"${acc_json}")"
  val_acc="$(holdout_field validationAccuracy <<<"${acc_json}")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${CYCLE}" "$(date -Iseconds)" "lamarck" "${test_acc}" "${val_acc}" "${promoted}" >> "${STATS}"

  if python3 -c "import sys; sys.exit(0 if float('${test_acc}') >= float('${TARGET}') else 1)"; then
    echo "[stop] reached target accuracy ${TARGET}" | tee -a "${LOG}"
    break
  fi

  remaining=$((DEADLINE - $(date +%s)))
  if [[ "${remaining}" -lt 120 ]]; then
    echo "[stop] less than 120s left before backprop slice" | tee -a "${LOG}"
    break
  fi

  # ---- Backprop slice ----
  bp_out="${OUT}/backprop_${CYCLE}"
  mkdir -p "${bp_out}"
  echo "[backprop] epochs=${BP_EPOCHS} → ${bp_out}" | tee -a "${LOG}"
  set +e
  "${BACKPROP}" train \
    "${CREATURE}" \
    "${DATA_DIR}" \
    --epochs "${BP_EPOCHS}" \
    --seed "${CYCLE}" \
    --learning-rate 0.0001 \
    --step-scale 0.0005 \
    --normalise-gradients \
    --max-records 16384 \
    --output-dir "${bp_out}" \
    >>"${LOG}" 2>&1
  bp_rc=$?
  set -e
  echo "[backprop] exit=${bp_rc}" | tee -a "${LOG}"

  promoted=0
  if [[ -f "${bp_out}/best.json" ]]; then
    if promote_if_better "${bp_out}/best.json" "backprop-${CYCLE}"; then
      promoted=1
    fi
  fi

  acc_json="$(holdout "${CREATURE}")"
  test_acc="$(holdout_field testAccuracy <<<"${acc_json}")"
  val_acc="$(holdout_field validationAccuracy <<<"${acc_json}")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${CYCLE}" "$(date -Iseconds)" "backprop" "${test_acc}" "${val_acc}" "${promoted}" >> "${STATS}"

  if python3 -c "import sys; sys.exit(0 if float('${test_acc}') >= float('${TARGET}') else 1)"; then
    echo "[stop] reached target accuracy ${TARGET}" | tee -a "${LOG}"
    break
  fi
done

final="$(holdout "${CREATURE}")"
echo "[final] ${final}" | tee -a "${LOG}"
echo "=== campaign complete ===" | tee -a "${LOG}"
