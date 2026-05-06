# XOR Classification Example with Decision-Boundary SVG

## Summary

Added a self-contained `xor_classification/` example that evolves a 2-2-1 NEAT-AI network on the
XOR truth table (the canonical "Hello World" of neuroevolution) and renders a decision-boundary
SVG suitable for embedding in the README. The example follows the same shape as `cart_pole/` and
`lunar_lander/`: a deterministic evolutionary loop, a champion saved to `.synthetic-xor/`, and an
SVG written to `docs/screenshots/xor_decision_boundary.svg`. Closes #57.

## Evidence

The change is a backend/CLI example with an SVG output (no web UI to capture via Playwright).
Verification was done via `./quality.sh`:

- `deno lint`, `deno fmt --check`, `deno check **/*.ts` all clean.
- Full unit-test suite (including the 17 new XOR tests) passes.
- All seven example runners — including the new `./xor_classification/run.sh` — exit 0.
- The new runner solves XOR in 22 generations (~50 ms) with the default seed, producing the
  committed `docs/screenshots/xor_decision_boundary.svg` showing the four diagonal-quadrant
  decision regions.

```mermaid
flowchart LR
    DATA[XOR Samples] --> EVOLVE[NEAT Evolution]
    EVOLVE --> CHAMP[Champion Creature]
    CHAMP --> RENDER[Render SVG<br/>Decision Boundary]
    RENDER --> SHOT[docs/screenshots/<br/>xor_decision_boundary.svg]
```

![XOR decision boundary](screenshots/xor_decision_boundary.svg)

## Test Plan

New tests in `xor_classification/xor_classification_test.ts` cover:

- **Happy path**: `evolveXorController` solves XOR with the default budget and the champion
  classifies all four samples correctly.
- **Edge case**: with a tiny budget (2 generations, threshold 0) `evolveXorController` still
  returns a usable champion that activates without throwing — exercising the "budget exhausted"
  branch.
- **SVG well-formedness**: `renderDecisionBoundarySVG` emits a parseable `<svg>` with positive
  width/height, exactly one `<g class="sample">` per XOR sample, the four labelled markers, and
  a configurable grid resolution (asserted by counting `<rect>` elements inside the grid group).
- **Genome plumbing**: `buildInitialCreatureJSON` validates as a `Creature`, throws on
  wrong-sized vectors, and `genesFromCreatureJSON` round-trips weights and biases.
- **Determinism**: `randomCreatureJSON` is reproducible for a given seed.
- **Metric sanity**: `meanSquaredError`, `correctCount`, and `predict` produce values in their
  expected ranges; `shadeColour` clamps and produces distinct hex strings at the ramp endpoints.

Other changes:

- `quality.sh` runs `./xor_classification/run.sh` as part of the example sweep and cleans
  `.synthetic-xor` before each run.
- `.synthetic-xor/` is already covered by the existing `.*` pattern in `.gitignore`.
