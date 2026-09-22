# Workflow — project-specific companion

The process itself is **not** described here. It lives in the global
`git-workflow-and-versioning` skill, in its "Worktree Lifecycle" section:

```
create worktree -> work -> verify -> review -> [fix -> verify] -> commit
                -> merge to main -> [conflict? -> resolve -> verify] -> remove worktree
```

Read that skill for the node definitions, the git-ownership rule (the top-level session owns
`worktree add`, `commit` and `merge`; a delegated subagent may run read-only git only), the
cleanup route, and the harness constraints that force the worktree to live inside the
repository. None of it is repeated here, deliberately: two copies of a process drift, and a
stale copy is worse than no copy.

What belongs *here* is what the global skill cannot know — this project's facts.

## Evidence commands for this project

`verify` means executable evidence. In this repository that is:

| When | Command |
|---|---|
| Every change | `node --test` — 108 tests, no dependencies, no browser needed |
| Proposal/diff path, rendering, or sanitizer touched | `node scripts/smoke.mjs` |
| Sanitizer touched | `node scripts/sanitize-dom-probe.mjs` |
| Proposal format touched | `node scripts/unified-path-probe.mjs` |

The three probes need a browser, which the app deliberately does not depend on, so they are
run with Playwright resolved from outside the project:

```sh
NODE_PATH=<somewhere-with-playwright>/node_modules node scripts/smoke.mjs
```

`.github/workflows/pages.yml` installs Playwright and runs the unit suite plus all three
probes, so anything committed here is gated by the same set.

## Worktrees in this repository

- Worktrees live under `.worktrees/<topic>`, which is gitignored (`.gitignore`), together
  with `.trash/` — the recoverable destination `safe-rm` uses.
- Branch naming follows the global skill: `feat/<desc>`, `fix/<desc>`, `docs/<desc>`,
  `test/<desc>`, lowercase kebab-case.
- The project root is `/Users/cheng/git/doc-reviewer`; `.worktrees/` sits inside it because
  the file sandbox permits writes nowhere else.

## Where this process is still weak

Recorded so the next agent does not mistake discipline for enforcement:

- The table above enumerates the evidence commands, but which *subset* a given change needs
  is still a judgement call, not a rule.
- The review node names "a reader other than the author" without pinning the mechanism:
  `audit-diff` for a diff-shaped read, `code-review` for a production-owner read, a
  subagent for adversarial falsification. Which applies to which change type is unspecified.
- Nothing enforces the node sequence. It is followed by discipline, so it drifts — as this
  session demonstrated before the pipeline was written down.
