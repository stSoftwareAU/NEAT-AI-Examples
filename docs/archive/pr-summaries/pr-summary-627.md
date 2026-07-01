## Summary

Removed the unused exported constant `MULTI_RUN_TIMELINE_SVG_PATH` (and its
leading JSDoc) from `mnist_classification/recorded_evolution.ts`.

Module-graph analysis in issue #627 flagged the export as dead code. I
confirmed it:

- No `.ts` file imports `MULTI_RUN_TIMELINE_SVG_PATH`, and it is not
  re-exported from any barrel.
- The identifier appeared exactly once in the whole repository — its own
  declaration.
- The timeline SVG artefact is written independently via
  `join(screenshotsDir, "timeline.svg")` (in both
  `recorded_evolution.ts` and `mnist_classification.ts`), so the constant
  was never the single source of truth for that path and removing it does
  not change any behaviour or artefact location.

Closes #627.

## Evidence

Pure dead-code removal — no web interface to screenshot. Verification was
via type-check, lint, format, and the module's unit tests:

- `deno check mnist_classification/recorded_evolution.ts` — clean.
- `deno lint mnist_classification/recorded_evolution.ts` — clean.
- `deno fmt --check mnist_classification/recorded_evolution.ts` — clean.
- `deno test --allow-all mnist_classification/` — **71 passed, 0 failed**.

The existing mnist tests still cover the chart-writing path that produces
`timeline.svg`, confirming the artefact is still generated after the
constant's removal.

## Test Plan

No new tests were added — this is the deletion of an unused export with no
behaviour to assert (and per `AGENTS.md` a test that greps for the absence
of a symbol would be a forbidden "how" test). The change is verified by the
existing `mnist_classification/` unit suite continuing to pass (71/71),
which exercises the recorded-evolution chart rendering that writes the
timeline SVG.
