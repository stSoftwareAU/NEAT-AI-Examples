#!/bin/bash
# =============================================================================
# SHARED: Ensure NEAT-AI-Discovery is built (runlib.sh)
# =============================================================================
#
# Shared helper: build the sibling NEAT-AI-Discovery clone so examples can
# use the Rust Discovery library; skip quietly when the clone is absent.
#
# Sibling layout:
#   PARENT_DIR/NEAT-AI-Examples
#   PARENT_DIR/NEAT-AI-Discovery
#
# There is no automatic fetch — clone NEAT-AI-Discovery as a sibling and this
# script runs ./scripts/runlib.sh when present.
#
# Usage:
#   source "common/ensure_neat_ai_discovery.sh"
#   ensure_neat_ai_discovery
#
# Options:
#   --no-runlib   Skip scripts/runlib.sh (sync-only check)
#
# =============================================================================

# Resolved once at source time — BASH_SOURCE[0] inside called functions would
# otherwise refer to the caller (example_runner_preamble.sh), not this file.
_ENSURE_NEAT_AI_DISCOVERY_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

ensure_neat_ai_discovery() {
  local run_runlib=1
  for arg in "$@"; do
    case "$arg" in
      --no-runlib) run_runlib=0 ;;
    esac
  done

  local common_dir="${_ENSURE_NEAT_AI_DISCOVERY_DIR}"
  local repo_root
  repo_root="$(cd -P "${common_dir}/.." && pwd -P)"
  local parent_dir
  parent_dir="$(cd -P "${repo_root}/.." && pwd -P)"
  local neat_dir="${parent_dir}/NEAT-AI-Discovery"

  if [[ ! -d "${neat_dir}" ]]; then
    printf '[ensure_neat_ai_discovery] NEAT-AI-Discovery not found at %s — skipping runlib (clone sibling repo for Rust Discovery)\n' \
      "${neat_dir}" >&2
    return 0
  fi

  if [[ "$run_runlib" -eq 1 && -x "${neat_dir}/scripts/runlib.sh" ]]; then
    (cd "${neat_dir}" && ./scripts/runlib.sh)
  elif [[ "$run_runlib" -eq 1 ]]; then
    printf '[ensure_neat_ai_discovery] scripts/runlib.sh missing in %s\n' "${neat_dir}" >&2
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  ensure_neat_ai_discovery "$@"
fi
