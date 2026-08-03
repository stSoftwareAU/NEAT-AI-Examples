#!/bin/bash
set -euo pipefail

# Quality Assurance Script
#
# This script runs linting, formatting checks, unit tests, and all
# example programs to verify they work correctly. It should be run
# before committing changes to ensure the examples remain functional.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${SCRIPT_DIR}"

# Track overall status
FAILED=0

echo "================================================"
echo "NEAT-AI Examples Quality Check"
echo "================================================"
echo ""

# Function to run an example and check for success
run_example() {
  local name="$1"
  local script="$2"

  echo "----------------------------------------"
  echo "Running: ${name}"
  echo "----------------------------------------"

  if "${script}"; then
    echo ""
    echo "SUCCESS: ${name}"
    echo ""
  else
    echo ""
    echo "FAILED: ${name}"
    echo ""
    FAILED=1
  fi
}

# Like run_example but invokes the runner with environment overrides,
# used for the lunar-lander "quick" CI budget so the section finishes
# in seconds without overwriting the canonical docs artefacts.
#
# The `script` argument may include positional arguments (e.g.
# `./tsp_two_opt/run.sh --instance=pcb442 --time-seconds=60`) — they are
# split on whitespace before invocation.
run_example_with_env() {
  local name="$1"
  local script="$2"
  local env_assignment="$3"

  echo "----------------------------------------"
  echo "Running: ${name} (${env_assignment})"
  echo "----------------------------------------"

  # Split the script string on whitespace so callers may pass positional
  # arguments alongside the runner path. No quoting is supported.
  # shellcheck disable=SC2206
  local cmd=(${script})

  if env "${env_assignment}" "${cmd[@]}"; then
    echo ""
    echo "SUCCESS: ${name}"
    echo ""
  else
    echo ""
    echo "FAILED: ${name}"
    echo ""
    FAILED=1
  fi
}

# --- Formatting ---
echo "----------------------------------------"
echo "Running: Deno Format"
echo "----------------------------------------"

if deno fmt; then
  echo ""
  echo "SUCCESS: Deno Format"
  echo ""
else
  echo ""
  echo "FAILED: Deno Format"
  echo ""
  FAILED=1
fi

# --- Linting ---
echo "----------------------------------------"
echo "Running: Deno Lint"
echo "----------------------------------------"

if deno lint; then
  echo ""
  echo "SUCCESS: Deno Lint"
  echo ""
else
  echo ""
  echo "FAILED: Deno Lint"
  echo ""
  FAILED=1
fi

# --- Type Checking ---
echo "----------------------------------------"
echo "Running: Deno Type Check"
echo "----------------------------------------"

if deno check ./**/*.ts; then
  echo ""
  echo "SUCCESS: Deno Type Check"
  echo ""
else
  echo ""
  echo "FAILED: Deno Type Check"
  echo ""
  FAILED=1
fi

# --- Unit Tests ---
echo "----------------------------------------"
echo "Running: Unit Tests"
echo "----------------------------------------"

# shellcheck source=common/ensure_neat_ai_native_scorer.sh
source "${SCRIPT_DIR}/common/ensure_neat_ai_native_scorer.sh"
ensure_neat_ai_native_scorer
ensure_rust_scorer_supports_cost CATEGORICAL_ERROR || true
rust_scorer_allow_run_args
# Preserve fallback state — do NOT default to "true" here; the probe above may
# have unset the variable intentionally when CATEGORICAL_ERROR is unsupported.
export NEAT_AI_RUST_SCORER_ENABLED="${NEAT_AI_RUST_SCORER_ENABLED:-false}"
export NEAT_AI_RUST_SCORER_BINARY_PATH="${NEAT_AI_RUST_SCORER_BINARY_PATH:-}"

DENO_TEST_ALLOW_RUN="df,bash,git,deno"
if [[ -n "${NEAT_AI_RUST_SCORER_BINARY_PATH:-}" ]]; then
  DENO_TEST_ALLOW_RUN="${DENO_TEST_ALLOW_RUN},${NEAT_AI_RUST_SCORER_BINARY_PATH}"
fi

DENO_TEST_FLAGS=(
  --frozen
  --v8-flags=--max-old-space-size=8192
  --no-check
  --allow-read
  --allow-write
  --allow-env
  --allow-net
  --allow-ffi
  --allow-run="${DENO_TEST_ALLOW_RUN}"
)

if deno test --parallel "${DENO_TEST_FLAGS[@]}" \
  --ignore=mnist_classification/evolve_integration_test.ts,mnist_classification/exploration_campaign_driver_test.ts; then
  echo ""
  echo "SUCCESS: Unit Tests (parallel)"
  echo ""
else
  echo ""
  echo "FAILED: Unit Tests (parallel)"
  echo ""
  FAILED=1
fi

echo "----------------------------------------"
echo "Running: MNIST evolveDir integration tests (isolated processes)"
echo "GitHub Actions runners are CPU-only; tests use timeoutMinutes: 0"
echo "and discoverySampleRate: -1 so evolveDir never schedules Discovery."
echo "----------------------------------------"

EVOLVE_INTEGRATION_FILTERS=(
  "evolveResultToMultiRunSample carries"
  "evolveMnistClassifier returns finite"
  "resume flow"
  "--fresh wipes"
  "rejects --target-error"
  "DEFAULT_MULTI_RUN_TARGET_ERROR"
  "--timeout override"
)

EVOLVE_INTEGRATION_FAILED=0
for filter in "${EVOLVE_INTEGRATION_FILTERS[@]}"; do
  if ! deno test "${DENO_TEST_FLAGS[@]}" \
    mnist_classification/evolve_integration_test.ts \
    --filter "${filter}"; then
    EVOLVE_INTEGRATION_FAILED=1
  fi
done

if [[ "${EVOLVE_INTEGRATION_FAILED}" -eq 0 ]]; then
  echo ""
  echo "SUCCESS: MNIST evolveDir integration tests"
  echo ""
else
  echo ""
  echo "FAILED: MNIST evolveDir integration tests"
  echo ""
  FAILED=1
fi

echo "----------------------------------------"
echo "Running: MNIST exploration-campaign driver tests (isolated processes)"
echo "Same evolveDir constraints as above; both the working root and the"
echo "recorded-artefact base dir are temp directories (issue #727)."
echo "----------------------------------------"

EXPLORATION_CAMPAIGN_FILTERS=(
  "records one phase per schedule entry"
  "resumes from the persisted champion"
  "rejects when there is no saved champion"
  "round-trips a persisted calibration record"
  "derives a four-rung ladder"
)

EXPLORATION_CAMPAIGN_FAILED=0
for filter in "${EXPLORATION_CAMPAIGN_FILTERS[@]}"; do
  if ! deno test "${DENO_TEST_FLAGS[@]}" \
    mnist_classification/exploration_campaign_driver_test.ts \
    --filter "${filter}"; then
    EXPLORATION_CAMPAIGN_FAILED=1
  fi
done

if [[ "${EXPLORATION_CAMPAIGN_FAILED}" -eq 0 ]]; then
  echo ""
  echo "SUCCESS: MNIST exploration-campaign driver tests"
  echo ""
else
  echo ""
  echo "FAILED: MNIST exploration-campaign driver tests"
  echo ""
  FAILED=1
fi

# --- Example Programs ---
# Clean up any previous synthetic data
echo "Cleaning up previous runs..."
rm -rf .synthetic-discovery .synthetic-intelligent-design .synthetic-suggest-improvements .synthetic-crossover .synthetic-crispr-injection .synthetic-cart-pole .synthetic-lunar-lander .synthetic-mountain-car .synthetic-snake .synthetic-maze .synthetic-xor .synthetic-stock .synthetic-mnist .synthetic-mcmc .synthetic-memetic-evolution .synthetic-synapse .synthetic-tsp-constructive .neuron-pruning .adaptive-mutation .discovery .discovery-at-scale
echo ""

# The NEAT-AI runtime checks disk space with `df` during some discovery
# phases. The individual example runners intentionally keep their
# permission lists explicit; this wrapper adds the one extra permission
# needed for a non-interactive full quality run.
DENO_BIN="$(command -v deno)"
DENO_WRAPPER_DIR="$(mktemp -d)"
# Invoked indirectly by the `trap ... EXIT` below, which shellcheck cannot see.
# shellcheck disable=SC2329
cleanup_deno_wrapper() {
  rm -rf "${DENO_WRAPPER_DIR}"
}
trap cleanup_deno_wrapper EXIT
cat > "${DENO_WRAPPER_DIR}/deno" <<EOF
#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "run" ]]; then
  for arg in "\${@:2}"; do
    if [[ "\${arg}" == "--allow-run"* ]]; then
      exec "${DENO_BIN}" "\$@"
    fi
  done
  exec "${DENO_BIN}" run --allow-run=df "\${@:2}"
fi
exec "${DENO_BIN}" "\$@"
EOF
chmod +x "${DENO_WRAPPER_DIR}/deno"
export PATH="${DENO_WRAPPER_DIR}:${PATH}"

# Run the Intelligent Design example
run_example "Intelligent Design Example" "./intelligent_design/run.sh"

# Run the Discovery example. The CI/quality budget caps the section via
# `DISCOVERY_QUICK=1` (issue #375): the runner forces a tiny iterations
# cap, writes its artefacts under a temp directory, and never overwrites
# the canonical docs SVG. A direct `./discovery/run.sh` invocation still
# uses the realistic 15-minute / target-error budget from
# `DEFAULT_DISCOVERY_CONFIG`.
run_example_with_env "Discovery Example" "./discovery/run.sh" "DISCOVERY_QUICK=1"

# Run the Discovery-at-Scale demo (issue #84)
run_example "Discovery at Scale Demo" "./discovery_at_scale/run.sh"

# Run the Crossover (Breeding) example. The CI/quality budget caps the
# section via `CROSSOVER_QUICK=1` (issue #374): the runner forces a tiny
# iterations cap, writes its artefacts under a temp directory, and never
# overwrites the canonical docs SVG. A direct `./crossover/run.sh`
# invocation still uses the realistic 15-minute / target-error budget
# from `DEFAULT_CROSSOVER_EVOLUTION_CONFIG`.
run_example_with_env "Crossover (Breeding) Example" "./crossover/run.sh" "CROSSOVER_QUICK=1"

# Run the CRISPR Gene Injection example. The CI/quality budget caps the
# section via `CRISPR_QUICK=1` (issue #373): the runner forces a tiny
# iterations cap, writes its artefacts under a temp directory, and never
# overwrites the canonical docs SVG. A direct `./crispr_injection/run.sh`
# invocation still uses the realistic 15-minute / target-error budget
# from `DEFAULT_CRISPR_EVOLUTION_CONFIG`.
run_example_with_env "CRISPR Gene Injection Example" "./crispr_injection/run.sh" "CRISPR_QUICK=1"

# Run the Cart-Pole Balancing example. The CI/quality budget caps the
# section via `CART_POLE_QUICK=1` (issue #321): the runner forces an
# `iterations: 3` cap, writes its artefacts under a temp directory, and
# never overwrites the canonical docs creature/milestones/charts. A
# direct `./cart_pole/run.sh` invocation still uses the realistic
# 5-minute / target-error=0.04 defaults.
run_example_with_env "Cart-Pole Balancing Example" "./cart_pole/run.sh" "CART_POLE_QUICK=1"

# Run the Lunar Lander Descent example in quick mode (issue #201): the
# CI/quality budget caps the section at ~6 seconds, exits via timeout,
# and skips writing the canonical docs artefacts. Direct invocations of
# `./lunar_lander/run.sh` still use the realistic 2-minute defaults.
run_example_with_env "Lunar Lander Descent Example" "./lunar_lander/run.sh" "LUNAR_QUICK=1"

# Run the Mountain Car Control example. The CI/quality budget caps the
# section via `MOUNTAIN_CAR_QUICK=1` (issue #323): the runner forces an
# `iterations: 3` cap, writes its artefacts under a temp directory, and
# never overwrites the canonical docs creature/milestones/charts. A
# direct `./mountain_car/run.sh` invocation still uses the realistic
# 5-minute / target-error=0.01 defaults.
run_example_with_env "Mountain Car Control Example" "./mountain_car/run.sh" "MOUNTAIN_CAR_QUICK=1"

# Run the Snake Game example. The CI/quality budget caps the section
# via `SNAKE_QUICK=1` (issue #325): the runner forces an `iterations: 3`
# cap, writes its artefacts under a temp directory, and never overwrites
# the canonical docs creature/milestones/charts. A direct
# `./snake_game/run.sh` invocation still uses the realistic 5-minute /
# target-error=0.01 defaults.
run_example_with_env "Snake Game Example" "./snake_game/run.sh" "SNAKE_QUICK=1"

# Run the Maze Navigation example. The CI/quality budget caps the
# section via `MAZE_QUICK=1` (issue #322): the runner forces an
# `iterations: 3` cap, writes its artefacts under a temp directory, and
# never overwrites the canonical docs creature/milestones/charts. A
# direct `./maze_navigation/run.sh` invocation still uses the realistic
# 5-minute / target-error=0.01 defaults.
run_example_with_env "Maze Navigation Example" "./maze_navigation/run.sh" "MAZE_QUICK=1"

# Run the TSP Constructive example (issue #458). The CI/quality budget
# caps the section via `TSP_CONSTRUCTIVE_QUICK=1`: the runner forces a
# tiny iterations cap, writes its artefacts under a temp directory, and
# never overwrites the canonical docs creature/milestones/screenshots.
# A direct `./tsp_constructive/run.sh` invocation still uses the
# realistic 5-minute / target-error=0.05 defaults on burma14.
run_example_with_env "TSP Constructive Example" "./tsp_constructive/run.sh" "TSP_CONSTRUCTIVE_QUICK=1"

# Run the XOR Classification example. The CI/quality budget caps the
# section via `XOR_QUICK=1` (issue #326): the runner forces a low
# iterations cap, writes its artefacts under a temp directory, and never
# overwrites the canonical docs creature/milestones/charts. A direct
# `./xor_classification/run.sh` invocation still uses the realistic
# 5-minute / target-error=0.05 defaults.
run_example_with_env "XOR Classification Example" "./xor_classification/run.sh" "XOR_QUICK=1"

# Run the Stock Market Direction Prediction example. The CI/quality
# budget caps the section via `STOCK_QUICK=1` (issue #328): the runner
# forces a low iterations cap, writes its artefacts under a temp
# directory, and never overwrites the canonical docs
# creature/milestones/charts. A direct `./stock_market/run.sh`
# invocation still uses the realistic 5-minute / target-error=0.01
# defaults.
run_example_with_env "Stock Market Direction Prediction Example" "./stock_market/run.sh" "STOCK_QUICK=1"

# Run the MNIST Handwritten-Digit Classification example. The
# CI/quality budget caps the section via `MNIST_QUICK=1` (issue #327):
# the runner forces a low iterations cap, writes its artefacts under a
# temp directory, and never overwrites the canonical docs
# creature/milestones/charts. A direct `./mnist_classification/run.sh`
# invocation still uses the realistic 5-minute / target-error=0.001
# defaults.
run_example_with_env "MNIST Handwritten-Digit Classification Example" "./mnist_classification/run.sh" "MNIST_QUICK=1"

# Run the tsp_two_opt example (issue #459) — learned 2-opt local-search
# heuristic on a TSPLIB instance. The CI/quality budget caps the section
# via `TSP_TWO_OPT_QUICK=1`: the runner forces a tiny iterations cap,
# writes artefacts under a temp directory, and never overwrites the
# canonical docs SVG. A direct `./tsp_two_opt/run.sh` invocation still
# uses the realistic 5-minute / target-error=0.05 defaults.
run_example_with_env "TSP Two-Opt Local Search Example" "./tsp_two_opt/run.sh" "TSP_TWO_OPT_QUICK=1"

# Run the pcb442 hybrid smoke (issue #483) — exercises the three NEAT-AI
# hybrid techniques (memetic re-seed, CRISPR splice, MH acceptance) on
# the 442-city instance with a 60-second wall-clock budget. The smoke
# inherits the `TSP_TWO_OPT_QUICK=1` discipline so its ephemeral
# artefacts go under a temp directory and the canonical
# docs/screenshots/tsp_two_opt.svg (burma14 default) is never
# overwritten. The committed pcb442 SVG at
# docs/screenshots/tsp_two_opt_pcb442.svg is produced by the user's
# manual smoke run, not by quality.sh.
run_example_with_env "TSP Two-Opt pcb442 Smoke" \
  "./tsp_two_opt/run.sh --instance=pcb442 --time-seconds=60" \
  "TSP_TWO_OPT_QUICK=1"

# Run the MCMC Mutation Acceptance demo
run_example "MCMC Mutation Acceptance Demo" "./mcmc_acceptance/run.sh"

# Run the Memetic Evolution demo
run_example "Memetic Evolution Demo" "./memetic_evolution/run.sh"

# Run the Synthetic Synapse Training demo. The CI/quality budget caps
# the section via `SYNAPSE_QUICK=1` (issue #389): the runner forces a
# tiny iterations cap, writes its artefacts under a temp directory, and
# never overwrites the canonical docs/screenshots SVGs or
# .synthetic-synapse/creatures/champion.json. A direct
# `./synthetic_synapse/run.sh` invocation still uses the realistic
# 20-minute / target-error=0.005 defaults from
# DEFAULT_SYNTHETIC_SYNAPSE_CONFIG.
run_example_with_env "Synthetic Synapse Training Demo" "./synthetic_synapse/run.sh" "SYNAPSE_QUICK=1"

# Run the Neuron Pruning demo
run_example "Neuron Pruning Demo" "./neuron_pruning/run.sh"

# Run the Adaptive Mutation Rate demo
run_example "Adaptive Mutation Rate Demo" "./adaptive_mutation/run.sh"

# Run the Suggest Improvements example. The CI/quality budget caps the
# section via `SUGGEST_QUICK=1` (issue #388): the runner forces a tiny
# iterations cap, writes its artefacts under a temp directory, and never
# overwrites the canonical docs CSV / SVGs. A direct
# `./suggest_improvements/run.sh` invocation still uses the realistic
# 15-minute / target-error=0.001 defaults from DEFAULT_MINIMAL_SEED_CONFIG.
run_example_with_env "Suggest Improvements" "./suggest_improvements/run.sh" "SUGGEST_QUICK=1"

# Summary
echo "================================================"
echo "Quality Check Summary"
echo "================================================"

if [ "${FAILED}" -eq 0 ]; then
  echo ""
  echo "All examples passed!"
  echo ""
  exit 0
else
  echo ""
  echo "Some examples failed. Please check the output above."
  echo ""
  exit 1
fi
