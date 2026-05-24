# PR Summary — Issue #481

## Summary

Extends the `tsp_two_opt` CLI so the harness can be smoke-tested in
sub-minute wall-clock without a multi-hour run:

- `parseInstanceFlag` in `tsp_two_opt/tsp_two_opt.ts` now accepts
  `pcb442` alongside `burma14` and `ulysses22`. The error message for
  an unknown instance lists `pcb442` as a valid option.
- New `parseTimeSecondsFlag` and `resolveTimeoutMinutes` helpers
  translate `--time-seconds=<N>` into the `timeoutMinutes` field
  consumed by `evolveTwoOptController` via `N / 60` (so 60s →
  `timeoutMinutes = 1.0`, 30s → `0.5`). When both `--time-seconds`
  and `--timeout` are supplied the seconds value wins (smoke beats
  human run); when absent, behaviour is unchanged from
  `DEFAULT_MULTI_RUN_TIMEOUT_MINUTES`.
- The `import.meta.main` entry point routes its `timeoutMinutes`
  through `resolveTimeoutMinutes(Deno.args, flags.timeoutMinutes)` so
  the pcb442 banner (`📍 Instance: pcb442 (442 cities, optimum
  50778)`) and the bounded budget land together on the same run.
- `tsp_two_opt/README.md` documents the new `pcb442` instance and the
  `--time-seconds=<N>` flag in the run-instructions block.

Closes #481.

## Evidence

CLI-only change — no UI surface to screenshot. Manual smoke run:

```
./tsp_two_opt/run.sh --instance=pcb442 --time-seconds=60 --fresh
…
📍 Instance: pcb442 (442 cities, optimum 50778)
🧬 Evolving controller via Creature.evolveEnv() — targetError=0.050, timeoutMinutes=1
…
✅ Champion ratio=2.3% (seed length 61984.05, final length 60532.27,
   optimum 50778, accepted 1/200, wallclock=60.9s).
🏁 Example completed in 1m 889ms
```

The banner prints the instance name, the 442-city count, and the
50,778 optimum, and the run returns within ~60s of evolution
wall-clock (plus the fixed startup overhead, well inside the issue's
10s slack).

### Flag-resolution flow

```mermaid
flowchart LR
    ARGV["Deno.args"]
    TS["parseTimeSecondsFlag<br/>--time-seconds=N"]
    TM["parseMultiRunFlags<br/>--timeout=M"]
    R["resolveTimeoutMinutes"]
    OUT["timeoutMinutes →<br/>evolveTwoOptController"]
    ARGV --> TS
    ARGV --> TM
    TS -->|N / 60 (wins if set)| R
    TM -->|fallback| R
    R -->|else DEFAULT_MULTI_RUN_TIMEOUT_MINUTES| OUT
```

## Test Plan

- New file `tsp_two_opt/tsp_two_opt_test.ts` with 14 tests covering:
  - `parseInstanceFlag` — accepts `pcb442`, `burma14`, `ulysses22`,
    defaults to `burma14`, and the unknown-instance error lists
    `pcb442` as a valid option.
  - `parseTimeSecondsFlag` — absence → `undefined`, parses `60`,
    rejects non-positive and non-numeric values.
  - `resolveTimeoutMinutes` — `--time-seconds=60` → `1.0`
    (`assertAlmostEquals`); `--time-seconds=30` → `0.5`;
    `--time-seconds=30 --timeout=5` resolves to `0.5` (smoke wins);
    `--timeout=7` alone resolves to `7`; neither flag falls back to
    `DEFAULT_MULTI_RUN_TIMEOUT_MINUTES`.
- Run with quality.sh test flags:
  `deno test --parallel --frozen --no-check --allow-read
  --allow-write --allow-env --allow-net --allow-ffi
  --allow-run=df,bash,git,deno tsp_two_opt/` →
  `ok | 31 passed | 0 failed`.
- Manual end-to-end smoke run of `./tsp_two_opt/run.sh
  --instance=pcb442 --time-seconds=60 --fresh` completed in
  ~61s wall-clock (see Evidence).
