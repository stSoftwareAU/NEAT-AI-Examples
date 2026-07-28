# Reword private-repo references in shared shell scaffolding comments

## Summary

Comments in the repo's shared shell scaffolding named the private `stSoftwareAU/GRQ` repository and
pointed public readers at its internal paths (`worker/shared/…`, `model_fetch.sh`, `learn.sh`) and
at an issue in its private tracker (`#1803`). None of those resolve for a public reader, and they
leak the shape of a private codebase for no benefit.

Every mention is reworded to concept level — what the script does for **this** repo — with the
private-repo cross-references dropped entirely. Comment text only; no executable line changed.
Closes #695.

| File                                     | Before                                                                                                              | After                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bump-deps.sh`                           | "Same role as stSoftwareAU/GRQ `bump-deps.sh`: run from the repo root, …"                                           | "Usage: run from the repo root, …"                                                                                           |
| `common/ensure_neat_ai_discovery.sh`     | "GRQ equivalent: worker/shared/…", "Sibling layout (same as GRQ …)", "Unlike GRQ, this repo has no model_fetch.sh"  | "Shared helper: build the sibling NEAT-AI-Discovery clone …", "Sibling layout:", "There is no automatic fetch"               |
| `common/ensure_neat_ai_native_scorer.sh` | "GRQ equivalent: worker/shared/…", "Unlike GRQ, … no model_fetch.sh or circuit breaker", "(#1803 behaviour in GRQ)" | "Shared helper: build rust_scorer from the sibling NEAT-AI-scorer clone …", "There is no automatic fetch or circuit breaker" |
| `common/example_runner_preamble.sh`      | "Shared preamble for every example run.sh — GRQ learn.sh equivalents for …"                                         | "Shared preamble sourced by every example run.sh — sets up …"                                                                |

## Evidence

No web interface to screenshot — this is a comment-only change to bash scaffolding. Verified by:

- `grep -rn "GRQ" bump-deps.sh common/*.sh` returns no matches.
- `bash -n` passes on all four modified scripts.
- `shellcheck` passes on all four modified scripts.
- `./quality.sh` passes (formatting, lint, type check, unit tests, and every example runner — the
  runners source `common/example_runner_preamble.sh`, so a broken comment block would surface
  there).

## Test Plan

No new tests. The change alters only comment text, so the only test that could observe it would have
to grep source files for comment strings — an explicitly forbidden "how" test under
[AGENTS.md § Testing Philosophy](../../../AGENTS.md#-testing-philosophy). Existing coverage is
unchanged and still passes: the full unit-test suite plus every example runner in `./quality.sh`
sources the two reworded `common/ensure_neat_ai_*.sh` helpers and
`common/example_runner_preamble.sh`, so their behaviour is exercised end to end.

This matches the precedent set by the sibling private-repo-reference fix in
[`pr-summary-693.md`](pr-summary-693.md), which was likewise comment/identifier-only and added no
new tests.
