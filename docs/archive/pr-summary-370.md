## Summary

Created the `Refresh-2026-05` milestone and bumped the `@stsoftware/neat-ai` JSR pin in `deno.json`
to the latest registry release (5.0.12 → 5.0.14) via `./bump-deps.sh`. All other JSR pins (`@std/*`,
`@stsoftware/tags`) were already at their latest published versions and were left unchanged by
`deno update --latest`. Closes #370. Part of #369.

## Evidence

`./quality.sh < /dev/null` ran to completion locally and printed `All examples passed!` — every
linter, formatter, type check, unit test, and example program ran cleanly against the bumped
runtime.

Diff applied by `./bump-deps.sh`:

```diff
-    "@stsoftware/neat-ai": "jsr:@stsoftware/neat-ai@5.0.12",
+    "@stsoftware/neat-ai": "jsr:@stsoftware/neat-ai@5.0.14",
```

Per the issue's acceptance criteria, only `deno.json` is included in this PR — no example artefact
changes are committed. `deno.lock` remains gitignored.

## Test Plan

- [x] `./quality.sh < /dev/null` passes locally (lint, format, type check, unit tests, and every
      example runner succeed against `@stsoftware/neat-ai@5.0.14`).
- [x] `deno.json` JSR pins refreshed to latest registry releases.
- [x] `Refresh-2026-05` milestone created on the repository.
- [x] PR attached to milestone `Refresh-2026-05` and links back to #369.
