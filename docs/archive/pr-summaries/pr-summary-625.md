# Remove dead-code unused export `CALIBRATION_PROBE_GENERATIONS`

## Summary

Removed the unused exported constant `CALIBRATION_PROBE_GENERATIONS` (and its leading JSDoc) from
`mnist_classification/exploration_campaign.ts`. Module-graph analysis and a repo-wide token search
confirmed the identifier appeared exactly once in the entire repository — its own declaration — with
no importer, no barrel re-export, and no string/dynamic reference in any `.ts`, `.sh`, `.md`, or
`.json` file. The neighbouring `CALIBRATION_PROBE_MINUTES` constant is still read elsewhere and was
left untouched. No calibration code path reads the removed value, so its removal is
behaviour-preserving. Closes #625.

## Evidence

Backend/CLI change only — no web interface to screenshot.

Verification performed:

- `grep -rn "CALIBRATION_PROBE_GENERATIONS"` across `*.ts`, `*.sh`, `*.md`, `*.json` returns **no
  matches** after removal (only match before was the declaration itself), confirming no
  dynamic/reflective lookup exists.
- `deno check mnist_classification/exploration_campaign.ts` — passes.
- `deno lint` and `deno fmt --check` on the file — clean.
- `deno test mnist_classification/exploration_campaign_test.ts` — 10 passed, 0 failed.

## Test Plan

No new tests were added: this is a pure dead-code deletion of a constant with no importers and no
behaviour to exercise. Per the project Testing Philosophy (AGENTS.md), a test asserting the symbol
is absent would be a forbidden "how" test (source inspection), and importing the removed symbol
would fail to compile. The existing `exploration_campaign_test.ts` suite (10 "what" tests) continues
to pass unchanged, confirming the surrounding calibration logic is unaffected.
