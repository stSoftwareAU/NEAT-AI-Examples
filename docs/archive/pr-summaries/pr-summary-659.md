## Summary

Removed the unused exported constant `DEFAULT_REPLAY_SEED` (and its now-orphaned doc comment) from
`snake_game/snake_game.ts`. A repository-wide identifier search confirmed the symbol occurred
exactly once — its own declaration — with no importer, no test reference, no re-export, and no
in-file use. The doc comment claimed _"Tests pin this so reruns produce identical SVGs"_, but that
claim was stale: no test referenced the constant. The sibling constant `DEFAULT_EVAL_SEEDS` is still
used elsewhere and was left untouched. Closes #659.

```
$ git grep -n "DEFAULT_REPLAY_SEED"     # before
snake_game/snake_game.ts:148:export const DEFAULT_REPLAY_SEED = DEFAULT_EVAL_SEEDS[0];

$ git grep -n "DEFAULT_REPLAY_SEED"     # after
(no matches)
```

## Evidence

Backend/library change with no web interface to screenshot. Verified by:

- `deno check snake_game/snake_game.ts` — passes (module type-checks after removal, proving no
  in-repo consumer referenced the symbol).
- `deno lint snake_game/` — clean across 7 files.
- `deno test snake_game/` — **48 passed | 0 failed**, confirming the deletion breaks no existing
  behaviour.

No new unit test was added: this is a pure dead-code deletion with no runtime behaviour to assert. A
test that checked for the _absence_ of an export would have to inspect source text, which is a
forbidden "how" test under [`AGENTS.md`](../../../AGENTS.md#-testing-philosophy). The existing
snake_game suite (which exercises the real evolution/replay path) passing unchanged is the correct
regression signal.

## Test Plan

- Ran the full existing `snake_game/` suite (`snake_game_test.ts`, `snake_test.ts`, `agent_test.ts`)
  — all 48 tests pass.
- Ran `deno lint` and `deno check` on the module — both clean.
