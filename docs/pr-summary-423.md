## Summary

Hardened `.github/workflows/gitleaks.yml` by removing the direct
`${{ github.base_ref }}` interpolation inside the `Run Gitleaks` step's
`run:` script. The PR base-ref is now exported via an `env:` mapping
(`BASE_REF`) and the shell script reads `${BASE_REF}` instead, matching
GitHub's recommended pattern for safe handling of context expressions
in shell scripts. The behaviour is unchanged — only the wiring is safer.

Closes #423.

## Evidence

This is a CI workflow / security hardening change with no UI surface.
The new Deno tests in `.github/gitleaks_workflow_test.ts` provide
machine-checkable evidence:

- One test parses the workflow YAML and asserts that **no** `run:` step
  contains a literal `${{ ... }}` interpolation.
- A second test asserts that the `Run Gitleaks` step exposes
  `github.base_ref` via an `env:` mapping and references the resulting
  shell variable (not the raw expression) in its script.

Both tests pass after the fix:

```
running 2 tests from ./.github/gitleaks_workflow_test.ts
gitleaks workflow — no run: step interpolates ${{ ... }} directly ... ok
gitleaks workflow — Run Gitleaks step passes base_ref via env: ... ok

ok | 2 passed | 0 failed
```

`./quality.sh` passes cleanly (exit 0).

### Before / after

```yaml
# before
- name: Run Gitleaks
  run: |
    ./gitleaks detect \
      --source . \
      --log-opts "origin/${{ github.base_ref }}..HEAD" \
      --verbose

# after
- name: Run Gitleaks
  env:
    BASE_REF: ${{ github.base_ref }}
  run: |
    ./gitleaks detect \
      --source . \
      --log-opts "origin/${BASE_REF}..HEAD" \
      --verbose
```

## Test Plan

- Added `.github/gitleaks_workflow_test.ts` with two assertions:
  - no `run:` block in the workflow inlines `${{ ... }}`;
  - the `Run Gitleaks` step passes `github.base_ref` via `env:` and
    references the env var (not the raw context expression) in `run:`.
- Verified locally with `deno test --allow-read .github/gitleaks_workflow_test.ts` — both tests pass.
- Verified `./quality.sh` exits 0.
