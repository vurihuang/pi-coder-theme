---
title: feat: Add Workspace Git Summary
type: feat
status: completed
date: 2026-05-19
---

# feat: Add Workspace Git Summary

## Summary

Extend the footer's Git change summary so it still reports useful totals when Pi is launched from a workspace directory that is not itself a Git repository. If the current working directory is not a repo, the editor should inspect only its direct child directories, detect child Git repositories, and aggregate their changed-file and line-change counts into the existing right-side status label.

---

## Problem Frame

The current right-bottom footer assumes the active `cwd` is the Git repository. That works for single-repo sessions, but it leaves users with no change summary when their normal working style is a parent workspace containing multiple repository directories.

---

## Requirements

- R1. Preserve the existing Git summary behavior when `cwd` is inside a Git repository.
- R2. When `cwd` is not a Git repository, inspect only direct child directories of `cwd` for Git repositories.
- R3. Aggregate all detected child repository changes into the existing changed-file, added-line, modified-line, and removed-line totals.
- R4. Do not scan grandchildren or deeper nested directories.
- R5. Keep the footer display compact and compatible with the current right-side status label style.
- R6. Avoid noisy failures when `cwd` has no child repositories, unreadable children, or child directories that are not Git repositories.
- R7. If a non-Git workspace has more than 10 direct child directories, skip workspace aggregation entirely to avoid UI latency.
- R8. Enforce an overall workspace aggregation time budget so footer rendering remains best-effort and cannot noticeably stall the Pi CLI.

---

## Scope Boundaries

- Do not introduce recursive workspace discovery beyond direct child directories.
- Do not add per-repository breakdown UI; this plan covers aggregate totals only.
- Do not change the existing footer layout, status-row truncation, colors, or label wording unless required to fit aggregate data into the current label.
- Do not change how the current Git branch is displayed for `cwd`; non-repo workspace mode should not invent a synthetic branch label.
- Do not add configuration for custom scan depth, repository include/exclude lists, child-count limit, or time-budget tuning.

### Deferred to Follow-Up Work

- Add optional per-repository drill-down or tooltip-style details if Pi later exposes a suitable compact interaction surface.
- Add configurable workspace discovery if users need grouped repository layouts or ignored child directories.

---

## Context & Research

### Relevant Code and Patterns

- `extensions/pi-coder-theme-editor.ts` owns the editor chrome, footer rendering, current `GitInfo` type, `runGit()`, `getGitInfo()`, `getCwdLabel()`, and `getGitChangesLabel()`.
- `extensions/pi-coder-theme-stale-context.test.ts` is the broad integration-style test file for editor/footer behavior and already contains helpers for rendering the custom editor with controlled `cwd` values.
- `package.json` defines `npm run typecheck`, `npm test`, and `npm run check` as the minimum validation suite for extension behavior.
- Existing implementation uses synchronous filesystem and child-process calls with short Git command timeouts, cached by `cwd` for two seconds. The workspace summary should preserve that low-latency, best-effort posture and add workspace-specific guardrails for child count and total scan duration.

### Institutional Learnings

- No repo-local `docs/solutions/` learnings were found for this task.

### External References

- No external research needed; this is a local extension behavior change using existing Node filesystem and Git CLI patterns already present in the repository.

---

## Key Technical Decisions

- Keep `getGitInfo(cwd)` as the single footer-facing entry point so `getCwdLabel()` and `getGitChangesLabel()` continue to consume one `GitInfo` shape.
- Detect direct-repo mode before workspace mode using an explicit Git work-tree check, not branch or status output. Existing behavior for a normal Git checkout must win whenever `cwd` is inside a repository.
- Use direct child directories only for workspace aggregation, matching the clarified user preference and avoiding unexpected deep scans.
- Skip workspace aggregation entirely when the workspace has more than 10 direct child directories; no partial count should be shown in that case.
- Treat child repository inspection as best-effort within an overall time budget. Unreadable directories, non-repos, Git command failures, and budget exhaustion should not surface errors in the UI.
- Reuse the current aggregate label format (`N files changed +A ~M -R`) rather than adding repository counts or a new workspace-specific suffix.

---

## Open Questions

### Resolved During Planning

- Should “二级目录” mean direct child directories or two levels deep? Resolved with the user: scan only direct child directories.
- Should the footer show per-repository details? No for this plan; aggregate totals preserve the current compact status row.

### Deferred to Implementation

- Exact helper names and export boundaries for testability should be chosen during implementation based on the smallest clean change to `extensions/pi-coder-theme-editor.ts`.
- Whether existing tests can access the custom editor render path directly or need a small exported pure helper can be decided while adding characterization coverage.

---

## Implementation Units

### U1. Separate single-repository Git collection from workspace aggregation

**Goal:** Preserve existing Git metrics for normal repository sessions while making the collection logic reusable for child repositories.

**Requirements:** R1, R3, R6

**Dependencies:** None

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- Extract the existing branch/status/numstat collection into a focused repo-level path that can run against any directory and return the existing `GitInfo` totals.
- Keep direct `cwd` repository behavior equivalent to today: branch comes from `cwd`, changed-file count comes from porcelain status, and line counts come from the current diff numstat logic.
- Preserve the existing cache keyed by the top-level `cwd` passed to the footer, not by every child repository.

**Execution note:** Add characterization coverage for the current single-repository footer behavior before changing the collection flow.

**Patterns to follow:**
- `extensions/pi-coder-theme-editor.ts` existing `runGit()` timeout/error-swallowing behavior.
- `extensions/pi-coder-theme-stale-context.test.ts` existing editor render tests and temporary-directory helpers.

**Test scenarios:**
- Happy path: given a temporary Git repository as `cwd` with a modified tracked file, rendering the editor shows the same changed-file and line-change style as the current implementation.
- Happy path: given a temporary Git repository with no changes, rendering the editor omits the Git changes label.
- Error path: given a directory where Git commands fail or return empty output, the collector returns zero changes rather than throwing.

**Verification:**
- Existing single-repository footer behavior remains visible and unchanged under test.
- TypeScript continues to accept the `GitInfo` shape without broad changes to render methods.

---

### U2. Add direct-child workspace repository aggregation

**Goal:** When `cwd` is not a Git repository, aggregate Git change metrics across direct child repositories only.

**Requirements:** R2, R3, R4, R6, R7, R8

**Dependencies:** U1

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- Detect whether `cwd` is a repository with an explicit Git work-tree check before attempting child aggregation; keep branch discovery separate from repo membership.
- If `cwd` is not a repository, enumerate direct child directories and skip workspace aggregation entirely when there are more than 10 child directories.
- For workspaces with 10 or fewer direct children, run the same explicit repo-membership check before collecting metrics from each child.
- Stop workspace aggregation when the overall time budget is exhausted; return the best-effort result gathered so far without blocking the UI longer.
- Sum `changedFiles`, `added`, `modified`, and `removed` across child repos that were scanned within the guardrails.
- Keep `branch` null for workspace aggregate mode so the cwd label remains a path-only workspace label.
- Ignore child directories that are not Git repositories and do not scan below them.

**Patterns to follow:**
- Current synchronous `readdirSync` / `statSync` style already used in `extensions/pi-coder-theme-editor.ts`.
- Current Git command failure behavior: return empty results instead of surfacing UI errors.

**Test scenarios:**
- Happy path: given a non-Git workspace directory containing two direct child Git repositories with changes, rendering the editor shows one aggregate changed-file count and aggregate line totals.
- Edge case: given a non-Git workspace with a direct non-repo child and one changed repo child, only the repo child contributes to totals.
- Edge case: given a direct child repo with no current branch name, repo membership is still detected and its changes contribute to workspace totals.
- Edge case: given a non-Git workspace with a nested repo under `group/repo`, no changes are shown because grandchildren are out of scope.
- Edge case: given a non-Git workspace with no child repositories, the Git changes label is omitted.
- Edge case: given a non-Git workspace with more than 10 direct child directories, workspace aggregation is skipped and no Git changes label is shown from child repos.
- Error path: given an unreadable or disappearing child directory during enumeration, rendering still succeeds and aggregates any remaining valid child repos.
- Error path: given child repository inspection that exceeds the overall time budget, rendering returns promptly with only the totals collected before the budget was exhausted.

**Verification:**
- Workspace aggregation appears only when `cwd` is not a repository.
- Direct children are considered; deeper descendants are ignored.
- Footer rendering remains stable when the workspace contains mixed repo and non-repo directories.

---

### U3. Keep footer rendering compact and cache-safe

**Goal:** Ensure the aggregate workspace totals integrate into the existing right-side label without layout regressions or stale cross-directory data.

**Requirements:** R1, R5, R6, R7, R8

**Dependencies:** U1, U2

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- Continue using `getGitChangesLabel()` as the sole formatter for right-side Git change text.
- Keep status-row truncation unchanged; aggregate labels should be clipped by the existing `statusRows()` behavior when terminal width is narrow.
- Ensure the Git cache is invalidated by `cwd` so switching between workspace and repo sessions cannot reuse the wrong summary.
- Keep the child-count and time-budget guardrails internal constants near the Git cache/collection logic so future maintainers see the footer performance contract where it is enforced.

**Patterns to follow:**
- Existing `getGitChangesLabel()` formatter and `statusRows()` truncation in `extensions/pi-coder-theme-editor.ts`.
- Existing tests that strip ANSI and assert rendered footer text.

**Test scenarios:**
- Happy path: aggregate workspace totals render using the same `files changed`, `+`, `~`, and `-` label conventions as a single repo.
- Edge case: after rendering one workspace and then another `cwd`, the second render reflects its own Git totals rather than cached totals from the first path.
- Edge case: at narrow terminal width, rendering does not exceed the requested width and the status row remains one terminal row.
- Edge case: repeated renders within the cache window do not rerun workspace scans, including skipped scans caused by the child-count limit.

**Verification:**
- No new footer row or alternate label format is introduced.
- Cache behavior remains scoped to the current `cwd`.
- Rendered output continues to fit within the requested terminal width.

---

## System-Wide Impact

- **Interaction graph:** Only the editor footer Git summary path changes; command palette, user-message rendering, thinking-step rendering, and theme token files are unaffected.
- **Error propagation:** Git and filesystem failures should be swallowed as zero-contribution signals, matching current `runGit()` behavior.
- **State lifecycle risks:** The existing short-lived cache can hide rapid filesystem changes for up to `GIT_CACHE_MS`; this is already accepted behavior and should remain unchanged.
- **API surface parity:** No public package API, Pi extension registration, theme JSON contract, or command palette contract changes are planned.
- **Integration coverage:** Temporary Git repositories in tests should prove the collector and rendered footer path together, not only pure arithmetic.
- **Unchanged invariants:** If `cwd` is a Git repository, child directories must not be scanned; existing single-repo behavior remains the priority path.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Workspace scanning adds latency in directories with many children | Skip workspace aggregation entirely when there are more than 10 direct child directories, enforce an overall time budget, reuse the existing short Git timeout, and keep the top-level cache. |
| The child-count limit can hide changes in large workspaces | Prefer UI responsiveness over completeness; users can launch Pi from a specific repo when a large workspace exceeds the aggregate-summary limit. |
| Tests using real Git repositories can be flaky if Git user config is required | Prefer file modifications and `git add` setup patterns that do not require commits. |
| Aggregate line counts may omit untracked file line counts | Preserve the current `git diff --numstat` behavior rather than expanding scope; changed-file count still includes porcelain entries. |
| A child repo with very slow Git status could delay render | Keep existing command timeout and treat timeout as zero contribution. |

---

## Documentation / Operational Notes

- README updates are optional because this is a small footer behavior enhancement, but a short changelog entry should mention workspace-level aggregation if this change ships in a release.
- Validate with `npm run typecheck`, `npm test`, and `npm run check` before reporting implementation complete.

---

## Sources & References

- Related code: `extensions/pi-coder-theme-editor.ts`
- Related tests: `extensions/pi-coder-theme-stale-context.test.ts`
- Existing plan convention: `docs/plans/2026-05-19-001-feat-goal-driven-worker-status-plan.md`
- Project scripts: `package.json`
