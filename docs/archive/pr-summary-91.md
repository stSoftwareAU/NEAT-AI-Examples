## Summary

Added a "🌟 Unique Features Showcase" section to the root `README.md` so visitors can find
demonstrations of NEAT-AI's distinctive capabilities at a glance. The section is a four-column table
(Feature, Demo, What it shows, Screenshot) with one row per consolidated unique-feature demo:
Discovery at Scale, Synthetic Synapse, Adaptive Mutation, Neuron Pruning, CRISPR Injection, MCMC
Acceptance, and Memetic Evolution. Each row links to the per-example README and embeds the example's
existing `docs/screenshots/*.svg`. Closes #91.

## Evidence

This is a documentation-only change. The behaviour is verified by new structural tests in
`readme_structure_test.ts` rather than a screenshot:

- `README.md has a Unique Features Showcase section` — confirms the new heading is present.
- `Unique Features Showcase row exists for <name>` — one assertion per demo, confirming both the
  per-example README link and the embedded screenshot live within the showcase section slice.
- `Unique Features Showcase screenshot <path> exists on disk` — one assertion per demo, confirming
  each referenced SVG is a non-empty committed file.

```mermaid
flowchart LR
    R[README.md]
    R --> S[Unique Features Showcase]
    S --> D1[Discovery at Scale]
    S --> D2[Synthetic Synapse]
    S --> D3[Adaptive Mutation]
    S --> D4[Neuron Pruning]
    S --> D5[CRISPR Injection]
    S --> D6[MCMC Acceptance]
    S --> D7[Memetic Evolution]
    D1 --> SS1[discovery_at_scale.svg]
    D2 --> SS2[synthetic_synapse.svg]
    D3 --> SS3[adaptive_mutation.svg]
    D4 --> SS4[neuron_pruning.svg]
    D5 --> SS5[crispr_injection.svg]
    D6 --> SS6[mcmc_acceptance.svg]
    D7 --> SS7[memetic_evolution.svg]
```

Quality gate (`deno lint`, `deno fmt --check`, `deno check`, `deno test`) passes with 849 unit tests
green.

## Test Plan

- `readme_structure_test.ts` — added the `UNIQUE_FEATURE_SHOWCASE` table and one row of assertions
  per entry covering: showcase heading present, per-example link present in the showcase slice,
  screenshot embedded in the showcase slice, and screenshot exists on disk.
- All existing assertions in `readme_structure_test.ts` continue to pass; no test was removed or
  weakened.
