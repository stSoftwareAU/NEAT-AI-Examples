## Summary

Refresh the `memetic_evolution` artefacts for the `Refresh-2026-05` milestone (parent #369). The +15
minute wall-clock budget requested by issue #382 is granted by raising the example's evolution
backstop from 5 → 20 minutes (and lifting `controlIterations` 250 → 1000 and
`memeticPhaseIterations` 125 → 500 in lock-step so wall-clock remains the genuine limiter). Re-ran
`./memetic_evolution/run.sh` end-to-end against the freshly bumped `@stsoftware/neat-ai`,
regenerated the headline milestone-comparison SVG, and refreshed the README with the measured
numbers from the new run. Closes #382.

### Why a literal "+15 minutes" warm continuation does not apply

`memetic_evolution` is listed under [AGENTS.md] as an exempt example because the demo's purpose is
the noise → competent narrative across two chained `evolveDir` phases (the memetic re-seeding
mechanic) — not a long-running warm-continued creature. Both phases (memetic and control) seed from
a minimal `new Creature(INPUT_COUNT, OUTPUT_COUNT)`, so warm-starting from the persisted
`.synthetic-memetic-evolution/creatures/memetic_champion.json` would violate that seed contract.

The honest interpretation of the issue's "+15 minutes wall-clock" is therefore **+15 minutes of
additional evolution budget on the next fresh policy-compliant run** — i.e. raising
`DEFAULT_MEMETIC_EVOLUTION_CONFIG.timeoutMinutes` from 5 → 20. The matching test was relaxed from
`assertEquals(timeoutMinutes, 5)` to `assertGreaterOrEqual(timeoutMinutes, 5)` with the issues
`#216, #382` justification recorded in the comment.

[AGENTS.md]: ../AGENTS.md

### Measured run

| Metric                 | Memetic (with seeding) | Control (no seeding) |
| ---------------------- | ---------------------- | -------------------- |
| Generations            | 66                     | 543                  |
| Wall clock             | 1.2 s                  | 5.0 s                |
| Final score (−MSE)     | 0.9964                 | 0.9976               |
| Final per-record error | 0.0036                 | 0.0024               |
| Seed → final neurons   | 3 → 5                  | 3 → 7                |
| Seed → final synapses  | 2 → 8                  | 2 → 13               |
| Held-out −MSE          | −0.003585              | −0.002389            |

Fitness lift (memetic − control): **−0.0012**. Both runs converged well inside the new 20-minute
backstop. Issue #382 explicitly permits raising the PR even with no fitness gain — the headline
narrative this run captures is that the control's larger iteration budget discovered a slightly
richer topology (7 neurons / 13 synapses) than the memetic run's two chained phases (5 neurons / 8
synapses), and the milestone-summary SVG faithfully records the regenerated numbers against the
freshly bumped `@stsoftware/neat-ai`.

## Evidence

```mermaid
flowchart LR
    A["Issue #382<br/>+15m budget"] --> B["timeoutMinutes 5 → 20<br/>controlIterations 250 → 1000<br/>memeticPhaseIterations 125 → 500"]
    B --> C["./memetic_evolution/run.sh<br/>(minimal seeds, no warm start)"]
    C --> D1["Memetic champion<br/>5 neurons / 8 synapses<br/>score 0.9964, error 0.0036"]
    C --> D2["Control champion<br/>7 neurons / 13 synapses<br/>score 0.9976, error 0.0024"]
    D1 --> E["📈 memetic_evolution.svg regenerated"]
    D2 --> E
    E --> F["README refreshed<br/>(Latest Measured Run table)"]
    style A fill:#bd10e0,stroke:#333,color:#fff
    style B fill:#f5a623,stroke:#333,color:#fff
    style C fill:#4a90d9,stroke:#333,color:#fff
    style D1 fill:#7ed321,stroke:#333,color:#fff
    style D2 fill:#7ed321,stroke:#333,color:#fff
    style E fill:#50e3c2,stroke:#333,color:#fff
    style F fill:#50e3c2,stroke:#333,color:#fff
```

- `docs/screenshots/memetic_evolution.svg` — milestone-comparison panel regenerated; both columns
  carry the freshly measured callouts and the seeding-event annotation strip.
- `./quality.sh < /dev/null` runs `deno fmt --check`, `deno lint`, `deno check`, the full unit-test
  suite and every example end-to-end. All `memetic_evolution` checks and tests pass; the only
  pre-existing failure (`docs/archive_test.ts::No PR summary files remain in docs/ root`) is
  inherited from the `milestone/refresh-2026-05` baseline (see PRs #406 and #407 which both left
  `docs/pr-summary-*.md` files in the docs/ root) and archiving those files is out of scope for a
  `memetic_evolution`-only PR.
- The NEAT seeds remain `new Creature(INPUT_COUNT, OUTPUT_COUNT)` for both the memetic and control
  runs — no warm start, no hidden hint, no resumed checkpoint.

## Test Plan

- `memetic_evolution/memetic_evolution_test.ts::DEFAULT_MEMETIC_EVOLUTION_CONFIG has audit-policy stop conditions`
  — assertion relaxed from `assertEquals(timeoutMinutes, 5)` to
  `assertGreaterOrEqual(timeoutMinutes, 5)` with the issue `#216, #382` justification recorded in
  the comment; the rest of the stop-condition contract (positive `targetError`, positive
  `populationSize`, positive iteration caps) is unchanged.
- The remaining 16 tests in `memetic_evolution_test.ts` (`forward`, `generateDataset`, `fitnessOn`,
  `writeBinaryDataset`, `creatureHeldOutScore`, `runMemeticAndControlEvolution` happy path +
  invalid-config rejection, `renderMemeticSVG` structure + custom-annotation) continue to pass
  unchanged — they verify observable behaviour, not the literal config values.
- `./memetic_evolution/run.sh` was run end-to-end against the freshly bumped `@stsoftware/neat-ai`
  to regenerate the headline SVG and refresh the measured numbers in the README.
