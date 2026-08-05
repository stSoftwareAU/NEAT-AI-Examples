# Terrain rect selected by a semantic class hook (Issue #741)

## Summary

The #181 regression test `renderRunSVG keeps the lander body above the ground at touchdown` located
the terrain silhouette by matching its exact fill colour and canvas width
(`<rect x="0" y="…" width="800" … fill="#3a2a1a"/>`) and pasted the renderer's private
`LANDER_HALF_LENGTH` constant as a literal `12`. Both are implementation-coupled: a legitimate
restyle or canvas resize would turn the test red with no behavioural regression, and tuning the
constant would silently drift the ground-clearance assertion.

The WHAT contract is unchanged — "the lowest body extent of both the static pose and the final
animation keyframe is at or above the terrain's top edge" — it just no longer cares what colour the
ground is:

- `lunar_lander/svg.ts` — the terrain rect now carries a `class="terrain"` hook, matching the
  existing `class="pad"` / `class="body"` / `class="anim-body"` hooks; `LANDER_HALF_LENGTH` is now
  exported.
- `lunar_lander/lunar_lander_test.ts` — selects the terrain by `class="terrain"` (no colour or width
  literal) and imports `LANDER_HALF_LENGTH` instead of hard-coding `12`.

This follows the repo's Testing Philosophy (AGENTS.md, from #726): select SVG elements by their
semantic `class` hook, never by pinned colour hex literals.

Closes #741.

## Evidence

Not a UI or performance change — the rendered SVG is visually identical (a `class` attribute was
added, no geometry or colour changed). Verified by test run:

```
renderRunSVG keeps the lander body above the ground at touchdown (issue #181) ... ok
ok | 12 passed | 0 failed (renderRunSVG filter)
ok | 1251 passed | 0 failed (full unit-test suite)
```

The repaired selector was confirmed to fail before the renderer change
(`TS2459: 'LANDER_HALF_LENGTH'
… is not exported`, and no `class="terrain"` in the emitted SVG),
then pass after it.

## Test Plan

- Modified
  `lunar_lander/lunar_lander_test.ts::renderRunSVG keeps the lander body above the ground at
  touchdown (issue #181)`
  — the #181 production regression test is kept intact; only its selector and its ground-clearance
  constant were de-coupled from the implementation.
- Full suite via `./quality.sh` (lint, format, type check, 1251 unit tests, examples).
