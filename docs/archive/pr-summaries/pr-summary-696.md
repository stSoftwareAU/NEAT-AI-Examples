# Reword private-repo mentions in archived PR summaries

## Summary

Two archived pull-request summaries named the private `stSoftwareAU/GRQ` repository, which does not
resolve for a public reader. Each mention is reworded to concept level; no other content changed.
Closes #696.

| File                | Before                                                                | After                                                                                   |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pr-summary-476.md` | "Wires the GRQ-style **exploration campaign** pipeline …"             | "Wires the phased **exploration campaign** pipeline …"                                  |
| `pr-summary-476.md` | "(new \"GRQ-Style Exploration Campaign\" section)"                    | "(new exploration-campaign section)"                                                    |
| `pr-summary-519.md` | "the closest example to the private GRQ market-prediction use case …" | "the closest example to a production market-prediction use case we operate elsewhere …" |

The `pr-summary-476.md` reference no longer quotes the live section title, so it stays accurate
whether or not the `stock_market/README.md` heading is retitled under the companion issue #694.

## Evidence

No web interface to screenshot — this is a documentation-only wording change in archived summaries.
Verified by:

- `grep -rn GRQ docs/archive/pr-summaries/pr-summary-476.md docs/archive/pr-summaries/pr-summary-519.md`
  returns no matches.
- `deno fmt --check` (509 files) and `deno lint` (178 files) pass.
- The unit-test suite passes — unchanged, since no code was touched.

## Test Plan

No new tests. The change alters only prose in archived documentation, so the only test that could
observe it would have to grep files for comment strings — an explicitly forbidden "how" test under
[AGENTS.md § Testing Philosophy](../../../AGENTS.md#-testing-philosophy). This matches the precedent
set by the sibling private-repo-reference fixes in [`pr-summary-693.md`](pr-summary-693.md) and
[`pr-summary-695.md`](pr-summary-695.md), which were likewise wording-only and added no new tests.
