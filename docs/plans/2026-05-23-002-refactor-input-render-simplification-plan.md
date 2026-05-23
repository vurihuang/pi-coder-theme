---
title: refactor: Simplify Input Render Timing
type: refactor
status: completed
date: 2026-05-23
origin: docs/brainstorms/input-render-simplification-requirements.md
---

# refactor: Simplify Input Render Timing

## Summary

Simplify the remaining editor input and status refresh timing code now that the fixed input box has been removed. The implementation should remove status refresh deferral around recent input, narrow the remaining no-text-change repaint fallback, and make the remaining body invalidation naming match its actual purpose.

---

## Problem Frame

The fixed input box removal eliminated the UI shape that made several input-timing safeguards necessary. The current code still carries input-aware status scheduling and multi-delay repaint fallbacks, which increase maintenance cost and make the normal editor path harder to reason about.

---

## Requirements

- R1. Typing normal text must still repaint immediately and clear completed elapsed-time status when text changes.
- R2. No-text-change inputs that affect visible editor state must still request a repaint.
- R3. Any retained async no-text-change repaint fallback must be narrower than the current multi-timer blanket behavior.
- R4. Status bar invalidations must continue to debounce/coalesce repeated status changes.
- R5. Status refresh scheduling must no longer depend on recent editor input timing.
- R6. Status data snapshotting must remain asynchronous enough to avoid expensive session/git/cost reads during render.
- R7. Input-timing helpers whose remaining purpose is body invalidation must be removed or renamed.
- R8. Editor body caching remains in place for this cleanup.
- R9. Tests that assert fixed-input-era timing behavior must be updated to match the simplified behavior.

**Origin actors:** A1 Pi user, A2 Theme maintainer, A3 Downstream planner/implementer
**Origin acceptance examples:** AE1 normal typing clears completed elapsed time, AE2 no-text-change input repaints without unnecessary repeated timers, AE3 status debounce no longer extends because of recent input, AE4 async status snapshot fallback remains safe

---

## Scope Boundaries

- In scope: status scheduler input-deferral removal, editor body invalidation naming, no-text-change repaint fallback narrowing, and related tests.
- In scope: preserving existing behavior for typing, cursor movement, command palette, elapsed-time clearing, status rows, and async status data refresh.
- Out of scope: removing editor body caching in this pass.
- Out of scope: removing async status data snapshots or moving expensive git/session/cost reads back into render.
- Out of scope: redesigning editor chrome, visual styling, command palette behavior, or status label contents.

### Deferred to Follow-Up Work

- Evaluate whether editor body caching can be removed later after measuring or characterizing `super.render()` cost during status ticks.
- Broader cleanup of git/cost/quota/session status collection can happen separately if future profiling shows it is still too complex.

---

## Context & Research

### Relevant Code and Patterns

- `extensions/pi-coder-theme-editor.ts` wraps the base editor TUI, tracks whether `super.handleInput` already requested render, invalidates editor body cache, schedules async input repaints, clears completed elapsed time, and wires the status scheduler.
- `extensions/editor-status/status-render-scheduler.ts` currently debounces dirty status/editor reasons and delays flushing when input happened recently.
- `extensions/editor-status/status-render-scheduler.test.ts` covers coalescing, cancellation, force refresh, and the current input-deferral behavior that should change.
- `extensions/pi-coder-theme-command-palette.test.ts` covers cursor/no-text-change repaint behavior, async repaint fallback behavior, command palette insertion/submission, and input history.
- `extensions/pi-coder-theme-stale-context.test.ts` covers elapsed-time clearing on typed input, async status data refresh after assistant messages, safe fallback snapshots before async refresh, and cached session usage during working ticks.
- `docs/plans/2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md` establishes that the fixed editor compositor has been removed and that cached status labels should not be deleted automatically.

### Institutional Learnings

- No `docs/solutions/` documents exist in this repository.

### External References

- External research was skipped. This is a repo-specific refactor of existing Pi TUI integration code with direct local tests and no external API or security surface.

---

## Key Technical Decisions

- Remove input-aware status deferral from the scheduler: recent editor input should not change when status dirty reasons flush, because the fixed input box race this guarded against is no longer part of the UI.
- Keep scheduler debounce/coalescing intact: the simplification targets input coupling, not the normal status batching behavior.
- Rename the editor callback around body cache invalidation: the remaining responsibility is making `PiCoderThemeEditor.render()` rebuild the editor body, not recording input timing.
- Narrow the no-text-change repaint fallback before considering full deletion: existing tests indicate some inputs can affect visible state without changing text, so the first cleanup should reduce timer fan-out while preserving one clear repaint path.
- Preserve editor body caching and async status snapshots: both protect normal editor rendering and expensive status collection independently of the removed fixed input box.

---

## Open Questions

### Resolved During Planning

- Which no-text-change paths still need repaint coverage? Cursor movement and async autocomplete-style paths are covered by existing tests, so the plan keeps an immediate repaint and narrows delayed follow-up behavior instead of removing repaint support entirely.
- Was status input deferral tied to the fixed input box? The origin and current code shape indicate yes; the plan removes this coupling while retaining normal debounce.
- Should editor body caching be removed now? No. It is preserved because it avoids repeated `super.render()` work during status ticks and is not fixed-input-specific.

### Deferred to Implementation

- Exact predicate for the retained async repaint fallback: choose the smallest implementation that satisfies the no-text-change and async autocomplete tests without restoring a blanket three-timer fan-out.
- Whether one delayed repaint is enough for paste/autocomplete behavior: validate against existing tests and add focused coverage if the implementation chooses a key-specific path.

---

## Implementation Units

### U1. Remove input deferral from the status scheduler

**Goal:** Make status dirty reasons flush on the normal debounce schedule regardless of recent editor input.

**Requirements:** R4, R5, R9; covers AE3

**Dependencies:** None

**Files:**
- Modify: `extensions/editor-status/status-render-scheduler.ts`
- Test: `extensions/editor-status/status-render-scheduler.test.ts`

**Approach:**
- Remove the scheduler's editor-input timestamp state and configurable input defer window.
- Remove the public input-marking method from the scheduler API.
- Keep `markStatusDirty`, generic `markDirty`, `forceRefresh`, `cancel`, dirty reason coalescing, and timer unref behavior.
- Replace the current input-deferral test with a test proving status dirty reasons flush after the configured debounce even if the scheduler no longer has input timing state.

**Patterns to follow:**
- Existing fake-timer scheduler tests in `extensions/editor-status/status-render-scheduler.test.ts`.
- Existing reason coalescing behavior that returns all dirty reasons in insertion order.

**Test scenarios:**
- Happy path: calling `markStatusDirty()` twice and `markDirty("editor")` still produces one callback after the debounce interval with both reasons.
- Happy path: forced refresh still bypasses pending debounce and includes all accumulated reasons.
- Edge case: `cancel()` still clears pending callbacks and dirty reasons.
- Regression: a status dirty event after arbitrary editor activity assumptions flushes after the normal debounce interval, not after an input-specific defer window.

**Verification:**
- Scheduler has no input-specific option, field, timestamp, or public method.
- Existing status debounce semantics still hold.

---

### U2. Rename editor body invalidation plumbing

**Goal:** Remove misleading input-timing terminology from editor render plumbing after the scheduler no longer tracks input timing.

**Requirements:** R1, R2, R7; covers AE1, AE2

**Dependencies:** U1

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-command-palette.test.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- Replace the extension-level `markEditorInput` callback with a name that describes its remaining behavior: invalidating the cached editor body.
- Update the TUI wrapper and editor constructor parameter names to reflect body invalidation rather than input timing.
- Keep the render request tracker that prevents duplicate immediate render requests when the base editor already requested one.
- Keep normal typing behavior: changed text clears completed elapsed time and requests an immediate editor render.
- Keep slash-command palette behavior: opening the palette invalidates the body as needed without clearing completed elapsed time until a command is inserted or submitted.

**Patterns to follow:**
- Current `PiCoderThemeEditor.handleInput` flow in `extensions/pi-coder-theme-editor.ts`.
- Existing elapsed-time and command palette assertions in `extensions/pi-coder-theme-stale-context.test.ts` and `extensions/pi-coder-theme-command-palette.test.ts`.

**Test scenarios:**
- Covers AE1. Happy path: with completed elapsed time visible, typing `h` clears the completed elapsed-time label and requests exactly one immediate render.
- Covers AE2. Happy path: cursor movement or another no-text-change input keeps the text unchanged and still requests one immediate repaint.
- Happy path: opening the slash command palette from empty input does not clear completed elapsed time until a command is selected.
- Integration: base editor render requests made during `super.handleInput` still prevent an extra duplicate wrapper request.

**Verification:**
- No editor helper name implies status input deferral after U1 removes that scheduler behavior.
- Current command palette and elapsed-time behavior remains covered by tests.

---

### U3. Narrow the no-text-change async repaint fallback

**Goal:** Reduce the blanket three-delay repaint fallback while preserving visibility for no-text-change inputs that can update editor state asynchronously.

**Requirements:** R2, R3, R9; covers AE2

**Dependencies:** U2

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-command-palette.test.ts`

**Approach:**
- Replace the current `[80, 250, 600]` delayed repaint fan-out with a narrower strategy.
- Prefer a single delayed repaint for no-text-change inputs unless implementation-time validation shows a key-specific predicate is safer.
- Clear any pending delayed repaint before scheduling a new one so repeated no-text-change inputs do not accumulate timers.
- Keep the immediate render request for no-text-change inputs; the delayed repaint is only a follow-up safety net for async base-editor updates.
- Update the test that currently expects at least four render requests so it asserts the new lighter behavior: immediate repaint plus the intentionally retained narrower follow-up.

**Patterns to follow:**
- Existing async repaint fallback test in `extensions/pi-coder-theme-command-palette.test.ts`.
- Existing async autocomplete test in the same file, which proves async suggestion resolution can request a normal editor repaint.

**Test scenarios:**
- Covers AE2. Happy path: a no-text-change input produces one immediate repaint and no more than the intended single delayed follow-up.
- Edge case: repeated no-text-change inputs before the delayed repaint fires cancel/replace the previous delayed repaint rather than stacking multiple timers.
- Integration: async autocomplete suggestion resolution still requests a normal editor repaint after the promise resolves.

**Verification:**
- The editor no longer maintains an array of multiple async input render timers.
- The retained fallback is visibly narrower than the old three-delay fan-out.

---

### U4. Preserve status snapshot and body-cache behavior with focused regression coverage

**Goal:** Ensure the simplification does not accidentally move expensive status collection into render or remove editor body caching.

**Requirements:** R6, R8; covers AE4

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`
- Test: `extensions/editor-status/status-layout.test.ts`

**Approach:**
- Leave `StatusLayoutCache`, `bodySnapshot`, and async status data refresh in place.
- Adjust any references affected by the helper renames from U2.
- Preserve the existing behavior where render before async status refresh uses fallback/snapshot data and later renders include refreshed token/cost usage.
- Preserve working tick behavior that reuses cached session usage instead of re-reading entries on every tick.

**Patterns to follow:**
- Existing stale-context tests for session usage refresh and cached working ticks.
- Existing status layout tests for label formatting and width behavior.

**Test scenarios:**
- Covers AE4. Happy path: initial render before async refresh uses fallback status data and does not synchronously read session usage.
- Integration: after assistant message end and async refresh, token and cost labels appear and a render is requested.
- Regression: working timer ticks update elapsed time without re-reading session entries after the initial snapshot.
- Edge case: missing or stale context fields still fall back safely instead of throwing during render.

**Verification:**
- No new render path directly calls git/session/cost collection helpers.
- `bodySnapshot` remains the mechanism for avoiding unnecessary base editor rendering during status-only updates.

---

### U5. Final cleanup and package validation

**Goal:** Remove stale tests/names left by the simplified timing model and verify the package remains releasable.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Modify: `extensions/editor-status/status-render-scheduler.ts`
- Test: `extensions/pi-coder-theme-command-palette.test.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`
- Test: `extensions/editor-status/status-render-scheduler.test.ts`
- Test: `extensions/editor-status/status-layout.test.ts`

**Approach:**
- Search for removed scheduler API names, input-defer terminology, and multi-timer async repaint terminology.
- Ensure tests describe the new simplified behavior rather than preserving fixed-input-era assumptions.
- Keep package scripts and Pi registration unchanged unless typecheck reveals now-dead exports.

**Patterns to follow:**
- Repository validation expectations in `AGENTS.md` and `package.json` scripts.

**Test scenarios:**
- Integration: full Vitest suite passes with the simplified scheduler/editor timing model.
- Integration: TypeScript compile succeeds with no stale imports or removed API references.
- Integration: Pi load check succeeds so the extension still registers in a clean Pi run.

**Verification:**
- `npm run typecheck`, `npm test -- --run`, and `npm run check` succeed.
- Searches for removed names do not find production references.

---

## System-Wide Impact

- **Interaction graph:** Editor input handling, editor body caching, status invalidation, status data refresh, command palette overlay, and elapsed-time status share the same render request surface.
- **Error propagation:** This refactor should not introduce new user-facing errors; stale context and missing status data should continue to fall back silently as they do today.
- **State lifecycle risks:** Delayed repaint timer cleanup is the main lifecycle risk. The implementation should avoid stacked timers and should not request renders after shutdown beyond existing safe optional chaining behavior.
- **API surface parity:** `StatusRenderScheduler` is internal to this package; public package behavior should remain unchanged except for lighter repaint timing.
- **Integration coverage:** Unit tests alone should be backed by existing integration-style extension tests that instantiate the editor through `session_start` and assert rendered output.
- **Unchanged invariants:** Theme colors, rounded editor chrome, command palette behavior, status label contents, async status data snapshots, and editor body caching remain intact.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing input deferral exposes a status/editor race that fixed-input removal did not fully eliminate. | Keep normal debounce, rely on existing render-request tests, and verify status updates after message end and working ticks. |
| Narrowing async repaint fallback breaks paste/autocomplete-style updates. | Preserve one immediate repaint and one narrower follow-up, then update async autocomplete/no-text-change tests around observable behavior. |
| Helper rename accidentally changes behavior while cleaning names. | Keep U2 focused on naming and render-body invalidation only, with elapsed-time and command palette tests as guardrails. |
| Body caching hides stale editor content after timing changes. | Invalidate body cache on all editor render request paths that currently mark input/body changes; keep body cache regression coverage. |

---

## Documentation / Operational Notes

- No README or user-facing documentation update is required for this internal simplification.
- If the implementation discovers visible behavior changes, document them in `CHANGELOG.md`; otherwise keep the release note focused on internal render simplification if a release is prepared.

---

## Sources & References

- **Origin document:** [docs/brainstorms/input-render-simplification-requirements.md](../brainstorms/input-render-simplification-requirements.md)
- Related plan: [docs/plans/2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md](2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md)
- Related code: `extensions/pi-coder-theme-editor.ts`
- Related code: `extensions/editor-status/status-render-scheduler.ts`
- Related tests: `extensions/pi-coder-theme-command-palette.test.ts`
- Related tests: `extensions/pi-coder-theme-stale-context.test.ts`
- Related tests: `extensions/editor-status/status-render-scheduler.test.ts`
- Related tests: `extensions/editor-status/status-layout.test.ts`
