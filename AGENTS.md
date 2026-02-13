# AGENTS.md — Guidelines for Humans and AI Agents

## Language

Use Australian English spelling in all code, comments, and documentation (e.g. colour, behaviour,
organisation, favour, metre, centre).

## Testing Philosophy

Every test in this project must be a **"what" test** — it verifies _what_ the code produces
(outputs, side effects, structure), never _how_ it produces it.

### "What" tests (good)

- Call a function with known input and assert the output value.
- Create a creature, activate it, and check that the result is finite.
- Generate data files and verify their existence and size.
- Remove a neuron and confirm the creature still validates and produces different output.

### "How" tests (bad — do not write these)

- Grep source code for a pattern or function name.
- Assert that one function calls another.
- Check that a specific algorithm or data structure is used internally.
- Inspect function bodies or count lines of code.

**Why?** "How" tests break whenever the implementation is refactored, even when behaviour is
unchanged. They add maintenance cost without catching real bugs.

## Unit Tests vs Benchmarks

| Aspect                 | Unit test                      | Benchmark                       |
| ---------------------- | ------------------------------ | ------------------------------- |
| **Purpose**            | Verify correct results         | Measure execution time          |
| **Runs in parallel?**  | Yes (via `deno test`)          | No — run in isolation           |
| **Timing assertions?** | Never                          | Always                          |
| **Location**           | `*_test.ts` next to the module | `*_bench.ts` next to the module |
| **Runner**             | `deno test`                    | `deno bench`                    |

### Why separate them?

Unit tests run in parallel with other tests, so any timing measurement is unreliable. If you switch
"quick sort" to "bubble sort", the unit tests should still pass (the output is the same), but a
benchmark will expose the regression.

### Rules

1. **Do not put timing assertions in unit tests.** If a test checks `performance.now()` or
   `Date.now()` deltas it belongs in a benchmark.
2. **Do not reduce iteration counts to make a "performance test" faster.** That defeats the purpose.
   Write a proper benchmark instead.
3. **Benchmarks are expected to take time.** That is their job.

## Writing Tests

- Place test files next to the module they test, named `<module>_test.ts`.
- Use `Deno.test(...)` with descriptive names.
- Import the functions under test directly — do not shell out or grep files.
- Each test must exercise real code: import a function, call it with test data, and assert on
  results, exit codes, or side effects.
- Clean up temporary files in a `finally` block.
- Use `Deno.makeTempDirSync()` for any file I/O so tests never pollute the working tree.

## Running Quality Checks

```bash
./quality.sh
```

This runs:

1. **Linting** — `deno lint` with the recommended rule set.
2. **Formatting** — `deno fmt --check` to enforce consistent style.
3. **Unit tests** — `deno test` across the entire project.
4. **Example programs** — each example runner script, verifying the full end-to-end workflow.

All steps must pass before merging.

## Project Structure

```
common/
  deterministic_random.ts          — Seeded PRNG for reproducible data generation
  deterministic_random_test.ts     — Unit tests for the PRNG
  synthetic_data.ts                — Shared synthetic data generation and scoring
  synthetic_data_test.ts           — Unit tests for data generation and scoring
  working_dirs.ts                  — Shared working directory setup
  working_dirs_test.ts             — Unit tests for directory setup

crossover/
  crossover_example.ts             — Example: breed two creatures (crossover)
  crossover_example_test.ts        — Unit tests for the above
  run.sh                           — Runner script for the example

discovery/
  discover_missing_neuron.ts       — Example: recover a removed neuron
  discover_missing_neuron_test.ts  — Unit tests for the above
  discover_missing_neuron_bench.ts — Benchmarks for the above
  run.sh                           — Runner script for the example

intelligent_design/
  improve_squash_example.ts        — Example: optimise activation functions
  improve_squash_example_test.ts   — Unit tests for the above
  improve_squash_example_bench.ts  — Benchmarks for the above
  run.sh                           — Runner script for the example

suggest_improvements/
  suggest_improvements.ts          — Analyse project and suggest improvements
  suggest_improvements_test.ts     — Unit tests for the above
  run.sh                           — Runner script for the example

quality.sh                         — Runs all tests and examples
deno.json                          — Deno configuration and dependencies
```
