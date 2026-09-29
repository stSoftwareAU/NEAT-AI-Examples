# PR Summary — #887: annotate `buildEpisodicAdapter`'s return type

## Summary

Closes #887.

`tsp_two_opt/tsp_two_opt.ts`'s exported `buildEpisodicAdapter` had an inferred return type. It now
declares `LegacyEpisodeAdapter<TwoOptEpisodeState, Float32Array>` (imported from
`@stsoftware/neat-ai`), so the compiler checks the public contract instead of deriving it from the
object literal.

The issue suggested `EpisodeAdapter` from `common/episode_runner.ts`, but that is a different
contract: it uses `initialState`, `encode` and `isTerminal`. This factory returns NEAT-AI's legacy
episodic shape (`inputCount`, `outputCount`, `maxSteps`, `reset`, `observe`, `decode`, and a `step`
that returns `{ state, reward, done }`). That shape is what `Creature.evolveEnv` consumes, and both
doc comments in the file already name `LegacyEpisodeAdapter`. Annotating with the local type would
not type-check.

- [x] Annotate the return type
- [x] fmt / lint / check / touched tests
- [x] Full quality gate

## Evidence

This is a type-only change with no runtime behaviour and no visual surface, so the evidence is
compiler and test output:

- `deno check tsp_two_opt/` checks all 10 files cleanly, including `tsp_two_opt_test.ts` and
  `hybrid.ts`, which consume the adapter.
- `deno test -A tsp_two_opt/` → `ok | 51 passed | 0 failed`.
- `./quality.sh < /dev/null` → exit 0, "All examples passed!".

No new test was added: the annotation is enforced by `deno check`, and the existing tests already
cover the adapter's behaviour.

## Test Plan

- `deno fmt --check && deno lint && deno check tsp_two_opt/`
- `deno test -A tsp_two_opt/ < /dev/null`
- `./quality.sh < /dev/null`
