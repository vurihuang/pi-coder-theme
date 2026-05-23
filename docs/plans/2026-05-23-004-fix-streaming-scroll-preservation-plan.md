---
title: fix: Preserve scrollback during streaming with theme thinking steps
type: fix
status: completed
date: 2026-05-23
---

# fix: Preserve scrollback during streaming with theme thinking steps

## Summary

Reduce theme-driven TUI redraws during LLM streaming so users can mouse-scroll up into terminal history without being immediately pulled back to the latest output. The plan aligns the bundled thinking-steps copy with upstream `pi-thinking-steps` behavior by treating message updates as state changes, not explicit render requests, then adds targeted regression coverage.

## Problem Frame

The theme currently makes terminal scrollback difficult to inspect while the assistant is streaming. Investigation found that upstream `amp-themes` does not bundle thinking-steps, and upstream `pi-thinking-steps` updates active thinking state during `message_update` without calling `requestRender()` on every thinking delta. This fork added a bundled `thinking-steps` extension that actively requests renders during streaming, and after the fixed-bottom compositor removal there is no longer an internal scroll offset layer to absorb those redraws.

## Requirements

- R1. Streaming assistant output must not receive extra redraw pressure from bundled thinking-steps beyond Pi's native message rendering.
- R2. Active thinking state must follow provider event semantics: active only during thinking start/delta and cleared once text/tool output begins or thinking ends.
- R3. Final thinking summary/cleanup behavior must remain correct at message/agent end.
- R4. The fix must preserve the existing package shape and avoid restoring the deleted fixed-bottom compositor.
- R5. Regression tests must cover the state transition that previously caused repeated active-state redraws during text streaming.

## Scope Boundaries

- Do not restore `extensions/fixed-editor/terminal-split.ts` or the fixed-bottom compositor stack.
- Do not import the full upstream `pi-thinking-steps` persistence/command system unless needed for this bug.
- Do not change theme colors, editor chrome layout, or tool display behavior.
- Do not attempt to detect terminal mouse scrollback state in the theme extension; Pi/TUI does not expose a reliable public hook for that.

### Deferred to Follow-Up Work

- Status spinner throttling during streaming: only pursue if the thinking-steps alignment does not sufficiently reduce scrollback interruption.
- Full upstream thinking-steps parity, including mode persistence and Alt+T controls: separate feature/refactor if desired later.

## Context & Research

### Relevant Code and Patterns

- `extensions/thinking-steps/index.ts` currently calls `requestRender(ctx)` inside `message_update` whenever the assistant message contains any thinking content.
- `extensions/thinking-steps/internal-patch.ts` patches `AssistantMessageComponent.updateContent()` and renders custom thinking components.
- `extensions/thinking-steps/state.ts` stores active thinking state and patch lifecycle state.
- `extensions/thinking-steps/internal-patch.test.ts` already covers patch lifecycle and thinking line height behavior.
- `extensions/pi-coder-theme-editor.ts` still has status refreshes and a working timer; those are secondary redraw sources and should not be changed unless needed.
- Upstream `pi-thinking-steps` uses `event.assistantMessageEvent.type` to set/clear active thinking state and does not call `requestRender()` during `message_update`.
- Upstream `amp-themes` does not bundle thinking-steps, which explains why its redraw surface is smaller.

### Institutional Learnings

- Recent plan `docs/plans/2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md` removed the fixed editor compositor; this fix should not undo that refactor.
- Recent plan `docs/plans/2026-05-23-003-fix-thinking-level-flicker-plan.md` addressed visual refresh timing. This plan must avoid reintroducing broad immediate refreshes during streaming.

### External References

- `https://github.com/me-frankan/amp-themes`: upstream theme package used for comparison.
- `https://github.com/crustyhacker/pi-thinking-steps`: upstream thinking-steps behavior used as the primary implementation pattern.

## Key Technical Decisions

- Treat thinking `message_update` as state-only: this matches upstream `pi-thinking-steps` and removes the extra render request that currently fights terminal scrollback.
- Use `assistantMessageEvent.type` instead of scanning all message content: content scanning keeps thinking active even after text streaming begins because old thinking blocks remain in the message.
- Keep `agent_end` cleanup render: the active-to-summary transition should still be visible after the turn completes, but it happens once rather than on every delta.
- Keep status spinner changes out of the first fix: the root regression is the copied thinking-steps render request; spinner throttling is a fallback if verification shows remaining unacceptable scroll disruption.

## Open Questions

### Resolved During Planning

- Should the fix restore the fixed-bottom compositor? No. It solved scroll preservation previously, but it was intentionally removed and is too large/risky for this regression fix.
- Should the bundled thinking-steps copy fully sync with upstream? No. The minimal fix is to copy the event semantics and no-explicit-render behavior that matter for this bug.

### Deferred to Implementation

- Whether status refresh throttling is still necessary after the thinking-steps fix: user-owned pre-release verification. The implementer attempted nested overlay and cmux-based checks, but nested overlay could not expose real terminal scrollback and cmux was unavailable because its socket was not running. The user explicitly chose to skip agent-run manual verification and test scrollback independently.

## Review Feedback to Incorporate

The first implementation pass satisfied the core code-path requirements but surfaced completion gaps that must be resolved before this plan can be considered shipped:

- U4 is user-owned for final pre-release validation. Automated render-spy tests prove the thinking-steps extension no longer calls `requestRender()` during `message_update`, but they do not prove the terminal remains usable while streaming. The user accepted this limitation and will test the real terminal scrollback behavior independently.
- Because agent-run manual verification was explicitly skipped, do not add status spinner throttling in this change. If the user's independent test still shows jump-to-bottom behavior caused by theme status refreshes rather than Pi native streaming output, handle spinner throttling as follow-up work.
- The final commit must include newly created files such as `extensions/thinking-steps/index.test.ts` and this plan document. Do not rely on `git diff --stat` alone, because it omits untracked files.
- The `internal-patch.ts` no-op line tracker change is acceptable only if tests and manual verification continue to show no stale thinking-line artifacts. If stale line overlap returns in real TUI output, address it directly rather than hiding it with broad redraw pressure.

## Implementation Units

### U1. Align thinking update handling with upstream event semantics

**Goal:** Stop bundled thinking-steps from actively requesting a TUI redraw on every streaming thinking update, and keep active thinking state scoped to actual thinking events.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `extensions/thinking-steps/index.ts`
- Test: `extensions/thinking-steps/index.test.ts` or equivalent colocated test if the repo's test setup prefers a different name

**Approach:**
- Replace `hasThinkingContent()` content scanning with a small event-normalization helper that reads `event.assistantMessageEvent.type` and `contentIndex`.
- Add a local type guard/normalizer for the event payload before accessing `assistantMessageEvent`, because the current local type only models `message.content` and older/incomplete event shapes should not throw.
- On `thinking_start` and `thinking_delta`, call `setActiveThinkingState({ active: true, contentIndex })` only.
- On `thinking_end`, `text_start`, `text_delta`, `text_end`, `toolcall_start`, `toolcall_delta`, and `toolcall_end`, clear active thinking state.
- For unrecognized or missing assistant event types, do nothing; do not fall back to scanning retained thinking content, because that was the source of false active state during text streaming.
- Remove `requestRender(ctx)` from `message_update` entirely.
- Keep the existing `agent_end` cleanup and final `requestRender(ctx)`.

**Execution note:** Implement this test-first if practical by extracting the event-to-state transition helper before wiring the Pi event handler.

**Patterns to follow:**
- Upstream `pi-thinking-steps/index.ts` `message_update` event handling.
- Existing local `withActiveUI()` and degraded-session guard in `extensions/thinking-steps/index.ts`.

**Test scenarios:**
- Happy path: `thinking_delta` with `contentIndex: 0` sets active thinking state with content index 0 and does not invoke a render callback.
- Happy path: `thinking_end` after active thinking clears active state.
- Integration: `text_delta` on a message that still contains an earlier thinking content block clears active state instead of reactivating it.
- Edge case: assistant event without `assistantMessageEvent` or without a recognized type does not throw and does not request render.

**Verification:**
- Streaming thinking updates no longer call `ctx.ui.requestRender()` from the thinking-steps extension.
- Final turn completion still clears active thinking state and refreshes the final display once.

---

### U2. Validate thinking renderer compatibility after state-only updates

**Goal:** Ensure the current `internal-patch.ts` behavior remains compatible with the new event semantics and does not depend on streaming-time explicit renders for correctness.

**Requirements:** R2, R3, R5

**Dependencies:** U1

**Files:**
- Modify: `extensions/thinking-steps/internal-patch.ts` if implementation reveals any coupling to the old active-state model
- Modify: `extensions/thinking-steps/internal-patch.test.ts`

**Approach:**
- Keep the current no-op `resetCompactLineTracker()` unless tests reveal stale line overlap returning.
- Confirm `ThinkingStepsComponent.render()` reads active state at render time and therefore works with Pi-native renders and final cleanup renders.
- Avoid reintroducing module-level line padding unless the existing regression test proves a real stale-line issue still exists.

**Patterns to follow:**
- Current local `ThinkingStepsComponent.render()` state lookup.
- Upstream `pi-thinking-steps/render.ts` cache behavior as reference only; do not port caching unless needed for the bug.

**Test scenarios:**
- Happy path: active thinking renders compact mode while state is active.
- Happy path: cleared state renders summary mode on the next render.
- Edge case: shrinking thinking summary does not leave stale padded lines in the component-level output expectation.

**Verification:**
- Existing thinking-steps tests pass with the state-only update model.
- No test relies on `message_update` calling global TUI render.

---

### U3. Add targeted regression coverage for no extra streaming redraws

**Goal:** Lock the scrollback-preservation fix with a focused regression matrix for thinking/text event transitions and render calls.

**Requirements:** R1, R5

**Dependencies:** U1

**Files:**
- Create or modify: `extensions/thinking-steps/index.test.ts`
- Modify: `vitest.config.ts` only if needed to include the new test file pattern

**Approach:**
- Treat this as the test matrix for U1 rather than a second implementation path; U1 owns the production behavior change, while U3 owns the render-spy and event-sequence coverage that prevents regression.
- Factor the event transition logic into an exported testable helper, or test through a small handler factory if that keeps production code cleaner.
- Use a fake context with `hasUI: true` and a spyable `ui.requestRender`.
- Simulate the event sequence that reproduced the bug: thinking delta, text delta while the message still has thinking content, agent end.
- Assert no render request during message updates and exactly one final render at agent end when not degraded.

**Patterns to follow:**
- Existing Vitest style in `extensions/thinking-steps/internal-patch.test.ts`.
- Existing command palette/editor tests for fake context construction if needed.

**Test scenarios:**
- Regression: `message_update` with `thinking_delta` does not call `ui.requestRender`.
- Regression: `message_update` with `text_delta` and retained thinking content does not call `ui.requestRender` and clears active state.
- Happy path: `agent_end` calls one render request after clearing active state.
- Error path: degraded patch state skips render attempts.

**Verification:**
- The test suite fails on the current implementation and passes after the event handling fix.

---

### U4. User-owned manual streaming verification and fallback decision

**Goal:** Leave final real-terminal scrollback verification to the user because nested agent overlays cannot expose the true mouse-scrollback behavior and cmux was unavailable during implementation.

**Requirements:** R1, R4

**Dependencies:** U1, U3

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts` only if manual verification shows status refreshes still make scrollback unusable
- Test: `extensions/editor-status/status-render-scheduler.test.ts` only if status throttling is added

**Approach:**
- Agent-run manual verification was attempted with nested `interactive_shell`, but the user confirmed nested overlay output cannot reliably demonstrate real terminal scrollback behavior.
- Agent-run cmux pane verification was attempted, but `cmux ping` failed because `~/Library/Application Support/cmux/cmux.sock` was not available.
- The user explicitly chose to skip agent-run U4 and test manually outside this implementation session.
- Do not add status spinner throttling without user-observed evidence that theme status refreshes, rather than Pi native streaming output, are the remaining contributor.

**Patterns to follow:**
- Existing `StatusRenderScheduler` debounce behavior.
- Current `startWorkingTimer()` / `stopWorkingTimer()` lifecycle in `extensions/pi-coder-theme-editor.ts`.

**Test scenarios:**
- Test expectation: none for this implementation session because no status throttling code is added.
- If user-owned verification later proves throttling is needed: Happy path test that streaming mode avoids frequent timer-driven render scheduling while still rendering status changes at agent start/end.

**Verification:**
- Agent records that nested overlay verification was attempted but rejected as insufficient by the user.
- Agent records that cmux pane verification was attempted but blocked by missing cmux socket.
- User explicitly accepts independent manual verification outside this session.
- If user-owned verification later fails, status spinner throttling remains deferred follow-up work rather than part of this completed change.

## System-Wide Impact

- **Interaction graph:** The change affects the thinking-steps extension's `message_update` handler and the patched assistant message renderer. Pi's native message rendering remains responsible for streaming output updates.
- **Error propagation:** Patch degradation should continue to warn once and avoid custom rendering; this plan should not add new failure paths.
- **State lifecycle risks:** Active thinking state must not remain true after text/tool output begins, or compact rendering could persist too long.
- **API surface parity:** Package extension list and public commands remain unchanged.
- **Integration coverage:** Tests should cover the event sequence across thinking and text deltas because unit testing only the renderer would miss the redraw trigger.
- **Unchanged invariants:** The fixed-bottom compositor remains removed; terminal scrollback behavior relies on reducing extra redraws rather than replacing Pi's viewport model.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing `requestRender()` makes live thinking animation less responsive | Accept this trade-off; upstream behaves this way, and final summary still refreshes at agent end. |
| Event shape differs across Pi versions | Add a local type guard/normalizer for `assistantMessageEvent`; leave unrecognized or legacy event shapes as no-ops rather than falling back to content scanning plus explicit render. |
| Status spinner still interrupts scrollback | Defer a small throttling change to U4 only if manual verification proves it necessary. |
| Tests overfit fake Pi event objects | Keep production normalization minimal and mirror upstream event names. |

## Documentation / Operational Notes

- Update `CHANGELOG.md` only if this fix is prepared for release.
- Release validation should include `npm run typecheck`, `npm test`, and `npm run check` before publishing.
- Before declaring completion, run a self-verification coverage audit that maps every requirement and U-ID to concrete evidence. The audit must confirm:
  - U1/U3: `message_update` thinking and text transitions are covered by regression tests that assert no `ui.requestRender()` call.
  - U2: renderer compatibility tests cover active compact rendering, cleared summary rendering, and shrinking output without stale padding expectations.
  - U4: user-owned manual verification has been explicitly accepted by the user, with agent-run nested overlay and cmux limitations recorded.
  - Git state: all created files required by the plan are tracked and included in the intended commit.
- Do not mark this plan `status: completed` until the self-verification coverage audit passes.

## Sources & References

- Related code: `extensions/thinking-steps/index.ts`
- Related code: `extensions/thinking-steps/internal-patch.ts`
- Related code: `extensions/pi-coder-theme-editor.ts`
- Related plan: `docs/plans/2026-05-23-001-refactor-remove-fixed-editor-compositor-plan.md`
- Related plan: `docs/plans/2026-05-23-003-fix-thinking-level-flicker-plan.md`
- External reference: `https://github.com/me-frankan/amp-themes`
- External reference: `https://github.com/crustyhacker/pi-thinking-steps`
