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

if deno test --no-check --allow-read --allow-write --allow-env; then
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
rm -rf .synthetic-discovery .synthetic-intelligent-design .synthetic-suggest-improvements .synthetic-crossover .synthetic-cart-pole .discovery
echo ""

# Run the Intelligent Design example
run_example "Intelligent Design Example" "./intelligent_design/run.sh"

# Run the Discovery example
run_example "Discovery Example" "./discovery/run.sh"

# Run the Crossover (Breeding) example
run_example "Crossover (Breeding) Example" "./crossover/run.sh"

# Run the Cart-Pole Balancing example
run_example "Cart-Pole Balancing Example" "./cart_pole/run.sh"

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
