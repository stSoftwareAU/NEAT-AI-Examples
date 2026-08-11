# PR Summary — Issue #791

## Summary

`docs/monitoring-neat-ai.md` presented itself as live guidance while being anchored to a finished
campaign, and its self-refresh step pointed at a dead URL. Re-anchored the document as the general
monitoring procedure for any re-evolve or long-run campaign — "the campaign's tracked issues"
replaces the hard-coded `#371–#390` framing in the intro, the defect template, the section 5 heading
and the Mermaid diagram — with a single historical note recording that #371–#390 were the first
application and are now closed. Fixed the broken link: NEAT-AI's default branch is `Develop`, so
`https://github.com/stSoftwareAU/NEAT-AI/blob/main/deno.json` 404'd and now points at
`.../blob/Develop/deno.json`. The de-duplication procedure, defect template and injectable checklist
block are unchanged in substance. Closes #791.

## Evidence

Documentation change only — no web interface to screenshot. Verified by the new tests in
`docs/monitoring_neat_ai_test.ts`, which fail against the pre-fix document and pass after it:

```text
# against HEAD's docs/monitoring-neat-ai.md (pre-fix)
monitoring doc links to NEAT-AI's deno.json on an existing branch ... FAILED
monitoring doc does not anchor live scope to a hard-coded issue range ... FAILED
FAILED | 1 passed | 2 failed

# after the fix
monitoring doc links to NEAT-AI's deno.json on an existing branch ... ok
monitoring doc does not anchor live scope to a hard-coded issue range ... ok
monitoring doc keeps the de-duplication procedure and defect template ... ok
ok | 3 passed | 0 failed
```

The dead branch was confirmed directly, not assumed:

```console
$ gh repo view stSoftwareAU/NEAT-AI --json defaultBranchRef -q .defaultBranchRef.name
Develop
```

## Test Plan

Added `docs/monitoring_neat_ai_test.ts` — three "what" tests asserting on the published document:

- **`monitoring doc links to NEAT-AI's deno.json on an existing branch`** — requires the
  `/blob/Develop/deno.json` link and rejects any `stSoftwareAU/NEAT-AI*/blob/main/` link, which
  cannot resolve because the repo has no `main` branch.
- **`monitoring doc does not anchor live scope to a hard-coded issue range`** — every hard-coded
  issue range (`#NNN–#NNN`) must sit in a context that marks it as history, so a future campaign
  cannot silently re-anchor the procedure to a closed set of issues. The check normalises whitespace
  first so it survives `deno fmt` rewrapping.
- **`monitoring doc keeps the de-duplication procedure and defect template`** — guards the parts of
  the document that remain genuinely useful (the `gh issue list` dedup search, the defect template
  section, and the idempotent `MONITOR-NEAT-AI-START` checklist block) against being dropped.
