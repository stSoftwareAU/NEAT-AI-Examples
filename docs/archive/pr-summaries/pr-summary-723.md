# PR Summary — Issue #723

## Summary

`tsp_constructive/environment_test.ts` asserted the GEO self-distance as the obfuscated expression
`Math.trunc(0 + 1)` under a test named "symmetric and **zero** between identical cities" — the name
contradicted the expectation, and nothing told a reader whether `1` was required behaviour or a bug
the test had enshrined.

It is required behaviour. TSPLIB95 §2.4 defines GEO as `dij = (int) (RRR * acos(...) + 1.0)`; for
coincident cities the arc term is `acos(1) = 0`, so the spec's integer rounding yields `1`, not `0`.
`geoDistance` in `tsp_constructive/environment.ts` implements exactly that, so the implementation is
correct and the assertion was merely undocumented.

Applied resolution 1 from the issue: replaced the expression with the plain literal `1`, added a
derivation comment citing the TSPLIB95 rounding rule, and renamed the test to state the actual
contract. No production code changed. Closes #723.

## Evidence

Backend/library change with no web interface, so no screenshot applies. Verified by running the
test:

```
$ deno test --allow-read tsp_constructive/environment_test.ts --filter "geoDistance"
geoDistance — symmetric, and identical cities are 1 km apart per TSPLIB GEO ... ok (823µs)
ok | 1 passed | 0 failed | 15 filtered out
```

## Test Plan

- Modified `tsp_constructive/environment_test.ts` — test renamed to "geoDistance — symmetric, and
  identical cities are 1 km apart per TSPLIB GEO"; expectation is now the literal `1` with a spec
  derivation comment. The symmetry assertion is unchanged.
- No tests were deleted or commented out; the assertion coverage is identical.
- Full `./quality.sh` run passes.
