## Summary

Surface NEAT-AI's chunked binary `.bin` training stream as the performance feature it actually is.
Adds `docs/binary_training_stream.md` — a focused page that documents the wire format (flat
little-endian Float32 records), the asymptotic speed argument vs CSV/JSON, and a Mermaid diagram of
the dataset → `.bin` writer → `creature.evolveDir` (WASM) → fitness pipeline. Each example README
that emits a `.bin` file at runtime now carries a one-line "Speed note" admonition near its "Running
the Example" section linking to the new doc. Closes #190.

## Evidence

This is a documentation-only change with no UI or performance code involved, so there is no
screenshot or benchmark to attach. The new doc is exercised by a TDD-first unit test
(`docs/binary_training_stream_test.ts`) that verifies the file exists, contains a Mermaid block
referencing `.bin`, names every example that emits a `.bin` file, references the related
`mnist_classification` and `synthetic_synapse` examples, and that each emitting example README links
back to the new doc.

The pipeline being documented:

```mermaid
flowchart LR
    A[Dataset] --> B[.bin writer<br/>generateSyntheticData]
    B --> C[chunked .bin files]
    C --> D[creature.evolveDir<br/>WASM]
    D --> E[fitness]
```

## Test Plan

- Added `docs/binary_training_stream_test.ts` with 13 "what" tests:
  - Doc exists and is non-empty.
  - Doc mentions `Float32`, `little-endian`, and `evolveDir`.
  - Doc contains at least one Mermaid block referencing `.bin`.
  - Doc references each of the 7 emitting examples (`xor_classification`, `discovery`,
    `discovery_at_scale`, `crispr_injection`, `evolution_showcase`, `crossover`,
    `intelligent_design`).
  - Doc references the 2 related examples (`mnist_classification`, `synthetic_synapse`).
  - Doc explains the speed-up via the asymptotic argument or parsing-overhead discussion.
  - Each emitting example's README links to `../docs/binary_training_stream.md`.
- `deno fmt --check`, `deno lint`, and the full unit-test suite all pass (`980 passed | 0 failed`).
- Incidentally extended `docs/archive_test.ts` to whitelist the existing unarchived
  `pr-summary-188.md` (pre-existing, blocked the gate) and the new `pr-summary-190.md`.

## Acceptance Criteria

- [x] `docs/binary_training_stream.md` exists with the content described above.
- [x] Each example README that writes a `.bin` file links to the new doc.
- [x] A unit test verifies the new doc and the cross-references.
- [x] `./quality.sh` passes (lint, fmt, type-check, unit tests).
