---
title: fix: Prevent status renders from resetting scrollback during streaming
type: fix
status: completed
date: 2026-05-24
---

# fix: Prevent status renders from resetting scrollback during streaming

## Summary

Fix the remaining scrollback interruption after the fixed compositor removal by reducing theme-owned terminal writes during active agent output. The plan keeps Pi's native TUI layout, avoids restoring the deleted terminal compositor, and makes status/elapsed/worker feedback update only when it is worth disrupting the terminal viewport.

---

## Problem Frame

The prior streaming-scroll plan fixed extra redraws from bundled thinking steps, but users still cannot reliably mouse-scroll during Pi agent output. Current investigation shows the remaining theme-owned redraw source is the editor status loop: `before_agent_start` starts a 250ms working timer, every tick mutates the visible spinner frame, and `StatusRenderScheduler` calls `activeTui.requestRender()`. In Pi's normal TUI path, any render writes terminal output; when a terminal is scrolled back with the mouse, continued program output pulls the viewport back to the bottom.

---

## Requirements

- R1. During active assistant streaming/tool execution, pi-coder-theme must not emit high-frequency status-only renders that make mouse scrollback unusable.
- R2. Preserve useful status information: working state, elapsed time, background worker state, model/context/git/token labels, and final completed elapsed time.
- R3. Keep the fixed-bottom compositor removed; do not reintroduce `terminal.write` interception, alternate screen, mouse reporting, or custom scroll regions.
- R4. Keep discrete user actions responsive: editor input, command palette, thinking-level switch, model switch, and session changes should still render promptly.
- R5. Add regression coverage proving status ticks are throttled/suppressed during streaming while start/end state changes still render.

---

## Scope Boundaries

- Do not restore `extensions/fixed-editor/terminal-split.ts` or any equivalent terminal split compositor.
- Do not attempt to detect native terminal mouse-scroll position; Pi/TUI does not expose a reliable public hook for that.
- Do not change `pi-tool-display` output formatting unless a later investigation proves it is independently causing scroll jumps.
- Do not remove status labels entirely; reduce their render cadence and animation pressure instead.
- Do not change theme colors, editor chrome layout, command palette behavior, or user-message rendering.

### Deferred to Follow-Up Work

- A Pi core/API improvement that exposes scrollback state or supports non-disruptive fixed footer updates belongs upstream, not in this package.
- A user-configurable “animated status” option can be added later if users explicitly want the old high-frequency spinner behavior.

---

## Context & Research

### Relevant Code and Patterns

- `extensions/pi-coder-theme-editor.ts` defines `STATUS_TICK_MS = 250`, `WORKING_FRAMES`, `startWorkingTimer()`, `stopWorkingTimer()`, and `setWorkingMessage()`.
- `startWorkingTimer()` currently runs while `isWorking`, async subagent timing, or background worker state is active; each tick changes `workingFrameIndex` and calls `invalidateStatus("status")`.
- `invalidateStatus()` invalidates `StatusLayoutCache` and calls `StatusRenderScheduler.markDirty()`, whose `onRender` calls `activeTui.requestRender()`.
- `node_modules/@earendil-works/pi-tui/dist/tui.js` shows `requestRender()` eventually writes terminal diff output; full renders clear scrollback in some cases, while even differential writes can pull a mouse-scrolled terminal back to live output.
- `docs/plans/2026-05-23-004-fix-streaming-scroll-preservation-plan.md` explicitly deferred status spinner throttling if real-terminal testing still showed jump-to-bottom behavior.
- The deleted `extensions/fixed-editor/terminal-split.ts` previously handled this by owning an internal `scrollOffset`, mouse reporting, alternate screen, and scroll-region repaint. That behavior is intentionally out of scope now.

### Institutional Learnings

- No `docs/solutions/` entries exist in this repository.
- Completed plan `docs/plans/2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md` is authoritative: Pi owns scrolling, selection, overlays, cursor, and terminal rows after compositor removal.

### External References

- Pi TUI implementation in `node_modules/@earendil-works/pi-tui/dist/tui.js` is sufficient for this plan; no external web research is needed.

---

## Key Technical Decisions

- Prefer throttling/suppressing status-only renders over terminal interception: this preserves the removal of the high-risk compositor while reducing scrollback disruption.
- Remove frame-based spinner animation from the streaming hot path: animated glyph changes are cosmetic and not worth terminal writes every 250ms.
- Keep lifecycle renders: entering work, changing work message, ending work, model/thinking/session changes, and editor input should still render because they communicate real state changes.
- Update elapsed time at coarse cadence only when visible value changes: the elapsed label changes once per second, so sub-second ticks provide no useful information.
- Make render reasons explicit enough to test: status tick behavior should be observable without relying on manual terminal scrolling in CI.

---

## Open Questions

### Resolved During Planning

- Should the fix restore the old compositor because it preserved scrollback? No. That was intentionally removed and violates the current architecture boundary.
- Is thinking-steps still the likely source? No. The completed plan already removed `message_update` render requests; current code-level evidence points to status timer renders.
- Should status labels be removed entirely during streaming? No. Coarse, state-driven updates are enough and preserve the theme's value.

### Deferred to Implementation

- Exact cadence for active elapsed updates: start with one-second updates; adjust only if tests or real use show it still causes too much scroll disruption.
- Whether background worker states need a slightly different cadence from normal agent streaming: decide while writing tests around `backgroundWorkerState` and `subagentTiming`.

---

## Implementation Units

### U1. Characterize current status render pressure

**Goal:** Add tests that fail against the current high-frequency status tick behavior and quantify which lifecycle events request renders.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `extensions/pi-coder-theme-stale-context.test.ts`
- Modify: `extensions/editor-status/status-render-scheduler.test.ts` if scheduler-level coverage is useful

**Approach:**
- Use fake timers around `before_agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, and `agent_end`.
- Spy on the fake TUI `requestRender` passed into the custom editor/footer factory.
- Capture the current failure mode: advancing timers by repeated 250ms intervals during active work produces repeated status-only render requests.
- Separately assert lifecycle events still request renders where appropriate.

**Execution note:** Start test-first so the implementation proves it reduces the exact remaining redraw source.

**Patterns to follow:**
- Existing fake-timer tests in `extensions/pi-coder-theme-stale-context.test.ts` around elapsed time and working ticks.
- Existing `StatusRenderScheduler` fake-timer style.

**Test scenarios:**
- Regression: active work for multiple 250ms intervals should not request a render on every interval.
- Happy path: `before_agent_start` still makes working status visible promptly.
- Happy path: `agent_end` still renders once to show completed elapsed time and clear working state.
- Integration: tool start/end message changes still render when the visible working message changes.

**Verification:**
- The new regression test fails before U2/U3 and passes after status tick throttling is implemented.

---

### U2. Replace animation ticks with value-changing status ticks

**Goal:** Stop cosmetic spinner-frame changes from driving terminal writes during streaming.

**Requirements:** R1, R2, R3, R5

**Dependencies:** U1

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- Remove or freeze `workingFrameIndex` changes while normal agent streaming is active.
- Replace the 250ms interval with a coarser status tick that only invalidates status when a displayed value changes, primarily elapsed seconds.
- Keep a stable working glyph or derive it from lifecycle state without requiring repeated renders.
- Start the interval only while there is active work or an active background worker; stop it reliably on `agent_end`, `subagent:async-complete`, background worker clear, and `session_shutdown`.

**Patterns to follow:**
- Current `startWorkingTimer()` / `stopWorkingTimer()` lifecycle cleanup in `extensions/pi-coder-theme-editor.ts`.
- `formatAgentElapsedTime()` granularity: seconds/minutes/hours are the visible boundaries worth refreshing.

**Test scenarios:**
- Happy path: after active work starts, advancing less than one visible elapsed boundary does not request repeated renders.
- Happy path: crossing a one-second elapsed boundary requests at most one status render.
- Edge case: repeated `startWorkingTimer()` calls do not create duplicate intervals.
- Edge case: completed elapsed time remains visible after `agent_end` without continuing an active interval.
- Error path: `session_shutdown` cancels pending timers and prevents later render callbacks.

**Verification:**
- No 250ms cosmetic status render loop remains in `extensions/pi-coder-theme-editor.ts`.

---

### U3. Preserve immediate renders for real state transitions

**Goal:** Ensure throttling does not make the UI feel stale when actual state changes occur.

**Requirements:** R2, R4, R5

**Dependencies:** U2

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`
- Test: `extensions/pi-coder-theme-command-palette.test.ts` only if command palette behavior is affected

**Approach:**
- Keep `forceStatusRefresh()` for discrete user actions that must be immediate, such as thinking-level and model selection.
- Keep direct editor input rendering through `PiCoderThemeEditor.requestEditorRender()` and the wrapped editor TUI path.
- Keep `setWorkingMessage()` render behavior for actual message transitions, but avoid rendering when the message text is unchanged.
- Ensure `tool_execution_update` does not repeatedly render if it only repeats the same visible message.

**Patterns to follow:**
- Current `thinking_level_select` and `model_select` immediate refresh handlers.
- Current `setWorkingMessage(message, ctx, force = false)` equality guard.

**Test scenarios:**
- Happy path: thinking-level selection still triggers immediate status refresh.
- Happy path: model selection still refreshes status and quota state.
- Happy path: typing in the editor still requests a normal editor repaint immediately.
- Regression: repeated `tool_execution_update` events with the same message do not spam render requests.

**Verification:**
- Status throttling only affects periodic/cosmetic updates, not user-visible state transitions.

---

### U4. Add optional diagnostics for remaining terminal-write sources

**Goal:** Make future debugging easier if real-terminal testing still shows scroll jumps after status throttling.

**Requirements:** R1, R3, R5

**Dependencies:** U2, U3

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts` only if a tiny opt-in diagnostic hook is justified
- Modify: tests only if diagnostics are added

**Approach:**
- Prefer no production diagnostics by default.
- If implementation needs observability, add an environment-gated counter/log for theme-owned status render requests, not broad terminal output logging.
- Keep diagnostics out of normal package output and do not expose secrets or session content.

**Patterns to follow:**
- Pi TUI's existing `PI_DEBUG_REDRAW` style in `node_modules/@earendil-works/pi-tui/dist/tui.js` as a conceptual pattern only.

**Test scenarios:**
- Test expectation: none if no diagnostics are added.
- If diagnostics are added: Edge case that diagnostics are disabled by default and enabled only by the environment flag.

**Verification:**
- The final fix can be validated without noisy default logs.

---

### U5. Validate and document the reduced-render behavior

**Goal:** Prove the package still works and record the performance/scrollback intent so future changes do not reintroduce high-frequency status renders.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `CHANGELOG.md` if preparing the fix for release
- Modify: `README.md` only if user-facing status behavior changes noticeably
- Test: existing `extensions/**/*.test.ts`

**Approach:**
- Run the normal repository validation after implementation.
- Manually verify in a real Pi terminal where possible: start a long streaming response, mouse-scroll up while output continues, and confirm theme-owned status updates no longer immediately pull the viewport down every 250ms.
- If the terminal still jumps only when actual assistant text streams, document that as Pi/native terminal behavior rather than a theme status-loop bug.

**Patterns to follow:**
- Repository guidance in `AGENTS.md`: `npm run typecheck`, `npm test`, `npm run check`, and package dry-run for package/theme release work.
- Prior plan `docs/plans/2026-05-23-004-fix-streaming-scroll-preservation-plan.md` manual verification notes.

**Test scenarios:**
- Integration: unit tests prove no high-frequency status-only render requests during active work.
- Manual: real terminal scrollback remains usable during a long response except for unavoidable native writes from actual streamed content.
- Release safety: package still loads with `pi --no-extensions --no-themes -e . -p 'Reply with ok'`.

**Verification:**
- Typecheck, unit tests, Pi load check, and targeted manual scrollback verification pass or any native Pi limitation is explicitly documented.

---

## System-Wide Impact

- **Interaction graph:** Agent lifecycle events still update `PiCoderThemeEditor` status, but periodic cosmetic animation no longer drives high-frequency `activeTui.requestRender()` calls.
- **Error propagation:** Timer cleanup remains important; stale timers after session replacement could still render against an old context if not cancelled.
- **State lifecycle risks:** Active work can involve normal agent runs, tool calls, async subagents, and background worker status; all paths must start/stop coarse ticks consistently.
- **API surface parity:** No public Pi APIs, package settings, themes, or skill entrypoints change.
- **Integration coverage:** Tests need event-sequence coverage because isolated scheduler tests cannot prove lifecycle handlers stop render spam.
- **Unchanged invariants:** Pi native TUI owns scrolling; pi-coder-theme only reduces its own avoidable redraw pressure.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Status feels less alive without spinner animation | Keep clear working text and elapsed updates; cosmetic animation is lower value than usable scrollback. |
| Elapsed time appears stale for up to one second | Acceptable because displayed elapsed precision is seconds; refresh on visible boundaries. |
| Background worker status needs more frequent feedback | Allow state-change renders and one-second elapsed updates; avoid sub-second animation unless manually proven necessary. |
| Tests pass but terminal still jumps during actual streamed text | Distinguish theme-owned status renders from unavoidable native output writes in manual verification notes. |
| A future change reintroduces a fast render loop | Regression tests should assert bounded render requests across fake-timer intervals during active work. |

---

## Documentation / Operational Notes

- This is a behavior fix, not a restoration of fixed input anchoring.
- Release notes should mention reduced status animation/render pressure during streaming if the change is published.
- Manual verification must happen in a real terminal session, not a nested interactive overlay, because nested overlays cannot faithfully demonstrate native mouse scrollback behavior.

---

## Sources & References

- Related code: `extensions/pi-coder-theme-editor.ts`
- Related code: `extensions/editor-status/status-render-scheduler.ts`
- Related code: `extensions/editor-status/status-layout.ts`
- Related test: `extensions/pi-coder-theme-stale-context.test.ts`
- Related test: `extensions/editor-status/status-render-scheduler.test.ts`
- Prior plan: `docs/plans/2026-05-23-004-fix-streaming-scroll-preservation-plan.md`
- Prior plan: `docs/plans/2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md`
- Pi TUI reference: `node_modules/@earendil-works/pi-tui/dist/tui.js`
