# Reword private-repo references in shared shell scaffolding comments

## Summary

Comments in the repo's shared shell scaffolding named a private production repository and pointed
public readers at its internal paths (`worker/shared/…`, `model_fetch.sh`, `learn.sh`) and at an
issue in its private tracker. None of those resolve for a public reader, and they leak the shape of
a private codebase for no benefit.

Every mention is reworded to concept level — what the script does for **this** repo — with the
private-repo cross-references dropped entirely. Comment text only; no executable line changed.
Closes #695.

| File                                     | Before                                                                                                                            | After                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bump-deps.sh`                           | a comment giving the script's role as "same as" the private repository's own `bump-deps.sh`                                       | "Usage: run from the repo root, …"                                                                                           |
| `common/ensure_neat_ai_discovery.sh`     | comments citing the private repository's equivalent script, its sibling layout, and its `model_fetch.sh`                          | "Shared helper: build the sibling NEAT-AI-Discovery clone …", "Sibling layout:", "There is no automatic fetch"               |
| `common/ensure_neat_ai_native_scorer.sh` | comments citing the private repository's equivalent script, its `model_fetch.sh` and circuit breaker, and an issue in its tracker | "Shared helper: build rust_scorer from the sibling NEAT-AI-scorer clone …", "There is no automatic fetch or circuit breaker" |
| `common/example_runner_preamble.sh`      | a comment describing the preamble as the equivalent of the private repository's `learn.sh`                                        | "Shared preamble sourced by every example run.sh — sets up …"                                                                |

## Evidence

No web interface to screenshot — this is a comment-only change to bash scaffolding. Verified by:

- A grep for the private repository's name across `bump-deps.sh` and `common/*.sh` returns no
  matches.
- `bash -n` passes on all four modified scripts.
- `shellcheck` passes on all four modified scripts.
- `./quality.sh` — `deno fmt`, `deno lint`, `deno check`, the full unit-test suite, and every
  example runner pass. Every runner sources `common/example_runner_preamble.sh` (which in turn
  sources both reworded `common/ensure_neat_ai_*.sh` helpers), so a broken comment block would
  surface immediately.
- One pre-existing, unrelated failure remains: **Adaptive Mutation Rate Demo** aborts with
  `ValidationError: Creature … has invalid score` thrown inside `jsr:@stsoftware/neat-ai@5.9.43`
  `FineTunePopulation.make`. It is already tracked as
  [#699](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/699) (filed before this branch) and
  is untouched by this comment-only change.

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
