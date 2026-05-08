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

# --- Formatting ---
echo "----------------------------------------"
echo "Running: Deno Format Check"
echo "----------------------------------------"

if deno fmt --check; then
  echo ""
  echo "SUCCESS: Deno Format Check"
  echo ""
else
  echo ""
  echo "FAILED: Deno Format Check"
  echo ""
  FAILED=1
fi

# --- Type Checking ---
echo "----------------------------------------"
echo "Running: Deno Type Check"
echo "----------------------------------------"

if deno check **/*.ts; then
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

if deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-ffi; then
  echo ""
  echo "SUCCESS: Unit Tests"
  echo ""
else
  echo ""
  echo "FAILED: Unit Tests"
  echo ""
  FAILED=1
fi

# --- Example Programs ---
# Clean up any previous synthetic data
echo "Cleaning up previous runs..."
rm -rf .synthetic-discovery .synthetic-intelligent-design .synthetic-suggest-improvements .synthetic-crossover .synthetic-crispr-injection .synthetic-cart-pole .synthetic-lunar-lander .synthetic-mountain-car .synthetic-snake .synthetic-maze .synthetic-xor .synthetic-stock .synthetic-mnist .synthetic-mcmc .synthetic-memetic-evolution .synthetic-synapse .neuron-pruning .discovery .discovery-at-scale
echo ""

# Run the Intelligent Design example
run_example "Intelligent Design Example" "./intelligent_design/run.sh"

# Run the Discovery example
run_example "Discovery Example" "./discovery/run.sh"

# Run the Discovery-at-Scale demo (issue #84)
run_example "Discovery at Scale Demo" "./discovery_at_scale/run.sh"

# Run the Crossover (Breeding) example
run_example "Crossover (Breeding) Example" "./crossover/run.sh"

# Run the CRISPR Gene Injection example
run_example "CRISPR Gene Injection Example" "./crispr_injection/run.sh"

# Run the Cart-Pole Balancing example
run_example "Cart-Pole Balancing Example" "./cart_pole/run.sh"

# Run the Lunar Lander Descent example
run_example "Lunar Lander Descent Example" "./lunar_lander/run.sh"

# Run the Mountain Car Control example
run_example "Mountain Car Control Example" "./mountain_car/run.sh"

# Run the Snake Game example
run_example "Snake Game Example" "./snake_game/run.sh"

# Run the Maze Navigation example
run_example "Maze Navigation Example" "./maze_navigation/run.sh"

# Run the XOR Classification example
run_example "XOR Classification Example" "./xor_classification/run.sh"

# Run the Stock Market Direction Prediction example
run_example "Stock Market Direction Prediction Example" "./stock_market/run.sh"

# Run the MNIST Handwritten-Digit Classification example
run_example "MNIST Handwritten-Digit Classification Example" "./mnist_classification/run.sh"

# Run the MCMC Mutation Acceptance demo
run_example "MCMC Mutation Acceptance Demo" "./mcmc_acceptance/run.sh"

# Run the Memetic Evolution demo
run_example "Memetic Evolution Demo" "./memetic_evolution/run.sh"

# Run the Synthetic Synapse Training demo
run_example "Synthetic Synapse Training Demo" "./synthetic_synapse/run.sh"

# Run the Neuron Pruning demo
run_example "Neuron Pruning Demo" "./neuron_pruning/run.sh"

# Run the Suggest Improvements example
run_example "Suggest Improvements" "./suggest_improvements/run.sh"

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
