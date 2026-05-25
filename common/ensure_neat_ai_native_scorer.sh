#!/bin/bash
# =============================================================================
# SHARED: Build rust_scorer from sibling NEAT-AI-scorer, export env
# =============================================================================
#
# GRQ equivalent: worker/shared/ensure_neat_ai_native_scorer.sh
#
# NEAT-AI (JSR @stsoftware/neat-ai) can score via the external binary when:
#   NEAT_AI_RUST_SCORER_ENABLED=true
#   NEAT_AI_RUST_SCORER_BINARY_PATH=<absolute path to rust_scorer>
#
# Sibling layout:
#   PARENT_DIR/NEAT-AI-Examples
#   PARENT_DIR/NEAT-AI-core
#   PARENT_DIR/NEAT-AI-scorer
#
# Unlike GRQ, this repo has no model_fetch.sh or circuit breaker — clone the
# sibling repos locally. On build failure we fall back to the JS/WASM scorer
# (#1803 behaviour in GRQ).
#
# Usage:
#   source "common/ensure_neat_ai_native_scorer.sh"
#   ensure_neat_ai_native_scorer
#   rust_scorer_allow_run_args
#
# =============================================================================

# Resolved once at source time — see ensure_neat_ai_discovery.sh.
_ENSURE_NEAT_AI_NATIVE_SCORER_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

ensure_neat_ai_native_scorer_use_js_fallback() {
  local reason="${1:-unknown}"
  unset NEAT_AI_RUST_SCORER_ENABLED
  unset NEAT_AI_RUST_SCORER_BINARY_PATH
  ALLOW_RUN_ARGS=()
  # Consumed by sourced run.sh — reference here so ShellCheck sees a read (SC2034).
  ((${#ALLOW_RUN_ARGS[@]} >= 0))
  printf '[native-scorer] unavailable (%s), using JS fallback\n' "${reason}" >&2
}

# Populate ALLOW_RUN_ARGS for a scoped --allow-run when rust_scorer is built.
# Callers splice with: ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"}
#
# Do not `export` this array — macOS bash 3.2 treats `export ALLOW_RUN_ARGS=(…)`
# as assignment + bare `export ALLOW_RUN_ARGS`, which trips `set -u` and leaves
# the flag unset so Deno never receives --allow-run.
rust_scorer_allow_run_args() {
  ALLOW_RUN_ARGS=()
  if [[ -n "${NEAT_AI_RUST_SCORER_BINARY_PATH:-}" ]]; then
    ALLOW_RUN_ARGS=("--allow-run=${NEAT_AI_RUST_SCORER_BINARY_PATH}")
  fi
  # Consumed by sourced run.sh — reference here so ShellCheck sees a read (SC2034).
  ((${#ALLOW_RUN_ARGS[@]} >= 0))
}

prepend_path_if_dir_exists() {
  local dir="${1:?}"
  [[ -d "${dir}" ]] || return 0
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
  esac
  PATH="${dir}:${PATH}"
  export PATH
}

maybe_load_rust_environment() {
  if command -v cargo >/dev/null 2>&1; then
    return 0
  fi
  if [[ -f "${HOME}/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "${HOME}/.cargo/env" >/dev/null 2>&1 || true
  fi
  prepend_path_if_dir_exists "${HOME}/.cargo/bin"
  prepend_path_if_dir_exists "/opt/homebrew/bin"
  prepend_path_if_dir_exists "/usr/local/bin"
}

ensure_neat_ai_native_scorer() {
  local common_dir repo_root parent_dir scorer_repo
  common_dir="${_ENSURE_NEAT_AI_NATIVE_SCORER_DIR}"
  repo_root="$(cd -P "${common_dir}/.." && pwd -P)"
  parent_dir="$(cd -P "${repo_root}/.." && pwd -P)"
  scorer_repo="${parent_dir}/NEAT-AI-scorer"

  maybe_load_rust_environment

  if [[ ! -d "${scorer_repo}" ]]; then
    ensure_neat_ai_native_scorer_use_js_fallback "NEAT-AI-scorer missing at ${scorer_repo}"
    return 0
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    ensure_neat_ai_native_scorer_use_js_fallback "cargo not found (install Rust via rustup)"
    return 0
  fi

  local build_log build_status
  build_log="$(mktemp -t ensure_neat_ai_native_scorer.XXXXXX.log)" || {
    ensure_neat_ai_native_scorer_use_js_fallback "mktemp failed for cargo build log"
    return 0
  }

  set +e
  (
    cd "${scorer_repo}"
    RUSTFLAGS="${RUSTFLAGS:--D warnings}" cargo build --release -p rust_scorer 2>&1
  ) | tee "${build_log}"
  build_status="${PIPESTATUS[0]}"
  set -e

  if [[ "${build_status}" -ne 0 ]]; then
    printf '[ensure_neat_ai_native_scorer] cargo build --release -p rust_scorer failed in %s (log: %s)\n' \
      "${scorer_repo}" "${build_log}" >&2
    ensure_neat_ai_native_scorer_use_js_fallback "cargo build failed"
    return 0
  fi

  rm -f "${build_log}"

  local binary_path="${scorer_repo}/target/release/rust_scorer"
  if [[ ! -x "${binary_path}" ]]; then
    ensure_neat_ai_native_scorer_use_js_fallback "built binary missing or not executable"
    return 0
  fi

  export NEAT_AI_RUST_SCORER_ENABLED="true"
  export NEAT_AI_RUST_SCORER_BINARY_PATH="${binary_path}"
}

# Verify the built rust_scorer advertises support for a NEAT-AI cost name
# (e.g. CATEGORICAL_ERROR). The probe runs `rust_scorer --help` once at
# preamble time and greps the help text for the cost token — it never
# touches a champion creature or training fixture, so it cannot violate
# the warm-start policy.
#
# Behaviour matrix:
#   * native scorer not built          → silent (already on JS fallback)
#   * probe binary missing or unreadable → silent (consistent with above)
#   * --help advertises the cost       → return 0
#   * --help does NOT advertise it     → warn on stderr and fall back to
#                                         the JS scorer; when
#                                         NEAT_AI_REQUIRE_NATIVE_SCORER=1
#                                         exit non-zero instead so an
#                                         operator notices on the first
#                                         generation rather than after a
#                                         night of batch fallback.
#
# Tracks issue #502 — MNIST native scorer requires rust_scorer
# CATEGORICAL_ERROR support; the same probe is reusable by any example
# that hard-depends on a specific cost.
ensure_rust_scorer_supports_cost() {
  local cost_name="${1:?cost name required}"
  local binary="${NEAT_AI_RUST_SCORER_BINARY_PATH:-}"
  if [[ -z "${binary}" ]]; then
    return 0
  fi
  if [[ ! -x "${binary}" ]]; then
    return 0
  fi

  local help_output help_status
  set +e
  help_output="$("${binary}" --help 2>&1)"
  help_status=$?
  set -e

  # An older rust_scorer may not implement --help at all. Treat a non-zero
  # exit or empty output as "unknown" — surface a softer warning so the
  # operator can investigate, but do not block the run.
  if [[ "${help_status}" -ne 0 || -z "${help_output}" ]]; then
    printf '[native-scorer] could not probe %s --help (exit %d); cost %s support unverified\n' \
      "${binary}" "${help_status}" "${cost_name}" >&2
    return 0
  fi

  if grep -qE "(^|[^A-Z_])${cost_name}([^A-Z_]|$)" <<<"${help_output}"; then
    return 0
  fi

  printf '[native-scorer] built rust_scorer at %s does NOT advertise cost %s\n' \
    "${binary}" "${cost_name}" >&2
  printf '[native-scorer] batch scoring will fall back to per-creature JS scoring on every generation.\n' >&2
  printf '[native-scorer] Update the sibling NEAT-AI-scorer checkout (see NEAT-AI-scorer#134) and rebuild.\n' >&2

  if [[ "${NEAT_AI_REQUIRE_NATIVE_SCORER:-0}" == "1" ]]; then
    printf '[native-scorer] NEAT_AI_REQUIRE_NATIVE_SCORER=1 set — failing fast.\n' >&2
    return 1
  fi

  ensure_neat_ai_native_scorer_use_js_fallback "cost ${cost_name} not advertised by rust_scorer"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  ensure_neat_ai_native_scorer
  rust_scorer_allow_run_args
fi
