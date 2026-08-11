## Summary

Audit all test cases per issue #5. The project had no unit tests — only example runner scripts that
executed the full workflow end-to-end. This PR:

1. **Adds 29 proper "what" unit tests** across both modules, verifying functional correctness
   (outputs, side effects, structure) without testing implementation details or timing.
2. **Exports key functions** from both example modules so they can be imported and tested directly.
   The intelligent design module's top-level code is now wrapped in an `import.meta.main` guard to
   prevent execution on import.
3. **Creates AGENTS.md** with clear guidelines distinguishing unit tests from benchmarks, and "what"
   tests from "how" tests, for both humans and AI agents.
4. **Updates README.md** with a testing section explaining how to run tests independently and the
   unit test vs benchmark distinction.
5. **Updates quality.sh** to run `deno test` before the example programs.

No existing tests were removed or commented out (there were none to begin with).

## Evidence

This is a backend/CLI project with no web interface. Evidence is the test output from
`./quality.sh`:

- **29 unit tests pass** (18 discovery + 11 intelligent design)
- **Both example programs succeed** (Intelligent Design + Discovery)

```
ok | 29 passed | 0 failed (109ms)
SUCCESS: Unit Tests
SUCCESS: Intelligent Design Example
SUCCESS: Discovery Example
All examples passed!
```

## Test Plan

### Discovery module (`discovery/discover_missing_neuron_test.ts`) — 18 tests

- `createDeterministicRandom` — values in range, deterministic for same seed, different for
  different seeds
- `createReferenceCreature` — correct structure (4 inputs, 4 hidden, 1 output), validates, activates
  with finite output, deterministic
- `createCrippledCreature` — removes target neuron, fewer neurons, fewer synapses, throws for
  unknown UUID, still activates, produces different output
- `generateSyntheticData` — creates expected files, correct file sizes, deterministic for same seed
- `SYNTHETIC_CONFIG` — has expected positive properties
- Integration: crippled creature scores worse than baseline on generated data

### Intelligent design module (`intelligent_design/improve_squash_example_test.ts`) — 11 tests

- `createReferenceCreature` — correct dimensions, 5 hidden neurons, validates, finite output,
  deterministic, diverse squash functions, has synapses
- `generateSyntheticData` — creates data file, correct file size, data can be scored by creature,
  contains valid float32 values
