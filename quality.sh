#!/bin/bash
set -euo pipefail

# Quality Assurance Script
#
# This script runs unit tests and all example programs to verify they
# work correctly. It should be run before committing changes to ensure
# the examples remain functional.

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
rm -rf .synthetic-discovery .synthetic-intelligent-design .discovery
echo ""

# Run the Intelligent Design example
run_example "Intelligent Design Example" "./intelligent_design/run.sh"

# Run the Discovery example
run_example "Discovery Example" "./discovery/run.sh"

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
