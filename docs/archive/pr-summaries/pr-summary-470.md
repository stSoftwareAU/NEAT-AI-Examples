## Summary

Surfaced both Travelling-Salesperson Problem (TSP) examples on the front README so readers can
discover them. Added two rows to the "🧬 Examples at a Glance" table — `tsp_constructive` and
`tsp_two_opt` — under a new **🗺️ routing** paradigm tag. The two example directories, their READMEs,
runners, and rendered SVGs already existed; only the top-level entry-point was out of date. Closes
#470.

Note: the original issue refinement assumed only `tsp_constructive` existed, but `tsp_two_opt` was
merged after refinement (commit 835dda0) and shared the same invisibility problem. The user's title
is plural ("examples"), so both rows are added together to satisfy the intent in a single change
rather than leaving `tsp_two_opt` for a follow-up issue.

## Evidence

Doc-only change to `README.md`. No UI, no code paths, no performance metric. Verified by:

- `./quality.sh < /dev/null` — all examples passed, 908 unit tests pass.
- Manual inspection of the rendered table — both new rows link to existing example READMEs
  (`tsp_constructive/README.md`, `tsp_two_opt/README.md`).

The new rows slot in between the agent group and the technique group:

```mermaid
flowchart LR
    A[🎮 Maze Navigation] --> B[📍 TSP Constructive]
    B --> C[🧭 TSP 2-Opt]
    C --> D[🛠 Intelligent Design]
```

## Test Plan

- No new tests — pure README addition. README content is not unit-tested in this repo (consistent
  with every prior row in the same table).
- `./quality.sh` continues to pass cleanly with the new rows in place.
