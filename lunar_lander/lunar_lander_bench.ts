/**
 * Benchmarks for the lunar-lander example.
 *
 * Home of the quick-mode wall-clock budget from issue #201: `run.sh --quick`
 * (and `LUNAR_QUICK=1`) must finish well inside 60 seconds so `quality.sh`
 * stays inside its per-section budget. That figure is a genuine performance
 * requirement, so per AGENTS.md ("Unit Tests vs Benchmarks") it is measured
 * here — in isolation, with the number reported — rather than asserted as a
 * `Date.now()` delta inside the parallel test runner (issue #724).
 *
 * Run with:
 *
 *   deno bench --allow-read --allow-write --allow-env lunar_lander/
 */

import {
  DEFAULT_EVOLVE_OPTIONS,
  evolveLanderController,
  QUICK_ITERATIONS,
  QUICK_TARGET_ERROR,
  QUICK_TIMEOUT_MINUTES,
} from "./lunar_lander.ts";

/* ------------------------------------------------------------------ */
/*  Quick-mode budget (issue #201)                                     */
/* ------------------------------------------------------------------ */

// A single evolution run costs seconds, so cap the sample count rather
// than letting the default iteration schedule run for minutes. `deno bench`
// reports the mean, which is the number to compare against the 60 s budget.
Deno.bench({
  name: "lunar_lander: quick-mode evolveLanderController (issue #201 60s budget)",
  n: 3,
  warmup: 0,
  fn: async () => {
    await evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      populationSize: 6,
      targetError: QUICK_TARGET_ERROR,
      timeoutMinutes: QUICK_TIMEOUT_MINUTES,
      iterations: QUICK_ITERATIONS,
    });
  },
});
