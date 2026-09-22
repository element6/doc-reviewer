# Worktree workflow

The pipeline every change in this repository follows. It exists because the obvious
version of it does not work here: two constraints discovered by trying it are recorded in
[Constraints](#constraints-discovered-the-hard-way) and they dictate the shape.

```
create worktree -> work -> verify -> review -> [fix -> verify] -> commit
                -> merge to main -> [conflict? -> resolve -> verify] -> remove worktree
```

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `TOPIC` | required | Short slug for the unit of work, e.g. `fix-pairing-test`. |
| `BRANCH` | `wt/<TOPIC>` | Branch the worktree is on. |
| `WORKTREE_PATH` | `.worktrees/<TOPIC>` | **MUST** be inside the repository — see C1. |
| `MAIN` | `main` | The branch work merges back into. |
| `MERGE` | `--no-ff` | **SHOULD** keep the unit visible as one merge in history. |
| `VERIFY` | per change | The project's evidence commands; see node N3. |

## Nodes

### N1 — create worktree
- **Input:** `TOPIC`
- **Process:** `git worktree add .worktrees/<TOPIC> -b wt/<TOPIC>`
- **Output:** a worktree on a new branch, sharing the repository's history.
- **Rules:** **MUST** place it under `.worktrees/` (C1). **MUST** confirm `.worktrees/` is gitignored before creating (C5).
- **Error:** if the path already exists, stop and report rather than reusing or overwriting it.

### N2 — work
- **Input:** the task, the worktree.
- **Process:** make the change, only inside the worktree.
- **Output:** modified files in the worktree.
- **Rules:** **MUST NOT** touch the main working tree. **MUST** keep the change to one coherent unit — if it splits into two, that is two worktrees and two commits.

### N3 — verify
- **Input:** the worktree.
- **Process:** run executable evidence, not inspection.
- **Output:** exit codes and their real output.
- **Rules:** **MUST** be executable evidence — a test run, a probe, a command whose output is quoted. Reading the code and concluding it is correct does not satisfy this node. **MUST** be green before review; a red verify means going back to N2, not forward.
- **Error:** a failing check is not a report to hand upward, it is work to do.

### N4 — review
- **Input:** the diff `main..HEAD` in the worktree.
- **Process:** a **separate reader** audits what the change introduced.
- **Output:** findings, each with file, severity, evidence and a fix direction.
- **Rules:** **MUST** be performed by someone other than the author — a subagent, or a skill whose rule is discovery-only. **MUST NOT** be skipped because N3 passed: verification proves behaviour, review catches regressions, dead code, weakened tests and docs that now contradict the code, which a passing suite cannot see. **MUST** be scoped to what the change introduced, not the whole codebase.

### N5 — fix loop
- **Input:** review findings.
- **Process:** fix, then re-run N3.
- **Output:** a green verify on the fixed change.
- **Rules:** **MUST** re-verify after every fix — a fix is an unverified change. **SHOULD** cap at two rounds; a third means the brief was wrong, so stop and report the residual risk instead of iterating.
- **Error:** if a finding is not going to be fixed, it **MUST** be recorded as an open item with its reason, not silently dropped.

### N6 — commit
- **Input:** the reviewed, green worktree.
- **Process:** commit in the worktree.
- **Output:** one commit whose message carries the decision record.
- **Rules:** **MUST** be one coherent unit. **MUST** explain *why* in the body, not only what — a future reader with no context is the audience.

### N7 — merge
- **Input:** `wt/<TOPIC>`, `MAIN`.
- **Process:** `git merge --no-ff wt/<TOPIC>` in the main working tree.
- **Output:** merged `MAIN`, or a conflict.
- **Rules:** **MUST** run from the main working tree, not the worktree.

### N8 — conflict resolution
- **Input:** a conflicted merge.
- **Process:** resolve, then re-run N3.
- **Output:** a green verify on the merged result.
- **Rules:** **MUST** re-verify after resolving: the merge result is a *new* state that no test has ever run against, and a clean textual merge can still be a semantic break. **MUST** stop for a human if resolution changes what the change was meant to do.
- **Error:** if resolution is not obviously correct, abort the merge and report — do not guess.

### N9 — remove worktree
- **Input:** a merged worktree.
- **Process:** recoverable removal, see C2.
- **Output:** no worktree, no stray branch, clean `git status`.
- **Rules:** **MUST** come after the merge — removing a worktree whose branch is unmerged destroys work (C4). **MUST** use the recoverable path in C2, because the direct commands are blocked.
- **Error:** if the recoverable path is also blocked, **HITL** — hand the exact command to the human rather than forcing anything.

## Constraints discovered the hard way

These are the tacit rules. Every one of them was learned by a command failing.

**C1 — the file sandbox confines writes to this repository.**
`mkdir /Users/cheng/git/dr-sandbox` → `Operation not permitted`. A worktree at
`../doc-reviewer-<topic>` cannot be created at all, because its parent is outside the
sandbox. **Worktrees MUST live under `.worktrees/` inside the repository.**

**C2 — the guard refuses unrecoverable git cleanup.**
`git branch -D` and `git worktree remove` (with or without `--force`) are both blocked as
"discards uncommitted work with no recovery path". The recoverable path is:

```sh
/Users/cheng/git/dsh-alpha/.dsh/scripts/safe-rm .worktrees/<TOPIC>   # moves to .trash/
git worktree prune                                                   # clears admin metadata
git branch -d wt/<TOPIC>                                             # safe delete; succeeds only once merged
```

`git branch -d` is deliberate: it refuses unless the branch is merged, which makes it a
second check that N7 really happened.

**C3 — delegated agents MUST NOT run git write commands.**
Subagents write files and report; the top-level session creates worktrees, commits and
merges. This is why N6 and N7 have no delegation variant.

**C4 — cleanup ordering is load-bearing.**
`git worktree remove` on an unmerged branch destroys the only copy of that work. N9 comes
after N7 for that reason, never before.

**C5 — `.worktrees/` and `.trash/` MUST be gitignored.**
Worktrees inside the repository show up as untracked files, and `safe-rm` moves deleted
paths into `.trash/` at the repository root. Both are ignored so `git status` stays a
truthful signal about the change itself.

## Human-in-the-loop checkpoints

- **N9** when the recoverable cleanup path is itself blocked — the human runs the command.
- **N8** when conflict resolution would change the intent of the change.
- **N5** when the fix loop reaches its second round without converging.

## Open gaps — this pipeline is v1 and expected to be wrong in places

Per the iterative rule that a first pipeline covers ~80% and each real failure adds a
rule, these are the known soft spots:

- `VERIFY` is described per change rather than enumerated. The honest current answer for
  this repository is `node --test` plus the browser probes when the proposal, rendering or
  sanitizer paths are touched; that mapping is not yet written down per change type.
- Whether worktrees should be reused across related units, or always fresh, is undecided.
- N4 names "a separate reader" without pinning which mechanism — the `audit-diff` skill for
  a diff-shaped review, `code-review` for a production-owner read, a subagent for
  falsification. Which one applies to which change type is not yet specified.
- Nothing enforces N1–N9; it is followed by discipline, so it will drift. A script that
  performs N1, N7 and N9 mechanically would remove the parts most likely to be skipped.

## Refinement 1 — T0 changes may skip the worktree

Learned by applying this pipeline to its own definition. A change with no logic branch —
documentation, a `.gitignore` entry, a configuration value — has nothing to merge and no
conflict surface, so N1, N7 and N9 are pure overhead for it. For such changes: work directly
on `MAIN`, verify by running the existing suite, review it if it is more than trivial, then
commit. Anything with a logic branch still goes through every node.
