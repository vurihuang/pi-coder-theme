---
title: "feat: Show agent elapsed time in editor"
type: feat
status: completed
date: 2026-05-18
---

# feat: Show agent elapsed time in editor

## Summary

Add a compact elapsed-time label to the custom Pi Coder editor so the user can see how long the current agent turn has been running. When the turn completes, the final elapsed duration remains visible in the input area until the user starts typing a new prompt, at which point the displayed duration resets.

---

## Problem Frame

The current editor status row shows whether the agent is waiting, streaming, or running tools, but once the user steps away there is no persistent at-a-glance indicator of how long the completed task took. The requested behavior is a lightweight terminal-native timer near the input box, using readable durations like `2m10s` and `1h30m`.

---

## Requirements

- R1. Display elapsed time for the current agent task at the input/editor area while the agent is running.
- R2. Freeze and keep showing the final elapsed time after the agent completes.
- R3. Reset and hide or clear the completed elapsed-time display only when the user enters new input content.
- R4. Format durations in readable compact form, including seconds/minutes/hours such as `2m10s` and `1h30m`.
- R5. Preserve existing editor chrome: context/cost/quota labels, working status, git changes, command palette, history, and fixed-editor compositing.
- R6. Keep all rendered lines within the TUI width and degrade gracefully in narrow terminals.
- R7. Cover elapsed-time formatting, lifecycle transitions, and reset behavior with regression tests.

---

## Scope Boundaries

- Do not persist elapsed durations across Pi restarts, `/reload`, `/new`, `/resume`, or `/fork`; this is an in-memory UI indicator for the active editor instance.
- Do not add configuration, commands, keybindings, or theme tokens for this first pass.
- Do not change the transcript, assistant messages, tool rendering, or session file format.
- Do not change Pi's built-in working indicator behavior beyond the current extension's existing hidden-working-row integration.
- Do not attempt to measure individual tool-call durations; the requested timer tracks the whole agent task from prompt submission to `agent_end`.

---

## Context & Research

### Relevant Code and Patterns

- `extensions/pi-coder-theme-editor.ts` owns the custom editor, working-state lifecycle, status rows below the editor, and fixed-editor compositor integration.
- `PiCoderThemeEditor.render()` already composes top labels, editor body, bottom path border, and status rows. This is the natural integration point for an elapsed-time label near the input box.
- The extension already tracks agent lifecycle through `before_agent_start`, `message_update`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, and `agent_end`.
- `workingTimer` currently drives animated working frames every 160ms and requests renders while the agent is active.
- `PiCoderThemeEditor.handleInput()` is the right interception point for resetting a completed elapsed-time display when user input changes, while still delegating normal editing behavior to `CustomEditor`.
- `extensions/pi-coder-theme-stale-context.test.ts` already has lifecycle tests for working messages and tool execution state.
- `extensions/pi-coder-theme-command-palette.test.ts` already has editor render tests and a reusable editor factory pattern.
- Pi extension docs confirm `before_agent_start` fires once after user prompt submission and `agent_end` fires once when the prompt's agent loop completes.
- Pi TUI docs require every render line to stay within the provided width and recommend `visibleWidth` / `truncateToWidth`, which this extension already uses.

### Institutional Learnings

- No `docs/solutions/` directory exists in this repository, so there are no local institutional learnings to carry forward.

### External References

- `@earendil-works/pi-coding-agent/docs/extensions.md`: agent lifecycle events and custom editor APIs.
- `@earendil-works/pi-coding-agent/docs/tui.md`: component render width rules and `CustomEditor` patterns.

---

## Key Technical Decisions

- Track elapsed time inside `extensions/pi-coder-theme-editor.ts` rather than adding a new extension: the existing editor extension already owns the relevant lifecycle hooks and render surface.
- Measure the whole agent task from `before_agent_start` through `agent_end`: this aligns with the user's “agent task” language and avoids confusing per-tool or per-turn timers.
- Reuse the existing render tick while active, but make it time-aware enough that the visible label updates at human-readable boundaries. The current 160ms animation interval is already sufficient for live updates; the implementation should avoid adding a second interval unless implementation proves it necessary.
- Keep the completed duration in memory after `agent_end` and clear it on meaningful editor input: this satisfies “until user inputs new content” without writing to session state.
- Render the label in the existing status row on the left side, before the working message when active. This keeps it visually attached to the input/editor area while avoiding transcript changes and preserving the existing top/bottom border labels.
- Export the duration formatter for direct unit testing, matching existing exported formatter coverage for ChatGPT quota helpers.

---

## Open Questions

### Resolved During Planning

- What counts as the task duration? Use the full agent run from `before_agent_start` to `agent_end`, not individual tool execution time.
- Should completed elapsed time survive session replacement or reload? No; the prompt asks for a local “when I come back” UI affordance, and this extension's state is already in-memory for working status.

### Deferred to Implementation

- Exact reset filtering for control keys: implementation should verify which `handleInput` data values mutate editor text and avoid clearing the completed duration for pure navigation where practical.

---

## Implementation Units

### U1. Add elapsed-duration state and formatter

**Goal:** Introduce the state and formatting primitives needed to track the active and completed agent-task duration.

**Requirements:** R1, R2, R4, R7

**Dependencies:** None

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- Add a small elapsed-time state model near the existing working-state variables: active start timestamp, latest completed duration, and a way to compute the display duration from `Date.now()` while active.
- Add an exported formatter that turns elapsed milliseconds or seconds into compact readable labels.
- Use seconds for sub-minute values, `XmYs` for minute-range values when seconds matter, and `XhYm` for hour-range values. Keep the formatter stable and unsurprising around boundaries like 59s, 60s, and 3600s.
- Clamp negative or invalid durations to a safe `0s`-style output rather than letting UI display nonsense.

**Execution note:** Implement the formatter test-first because its behavior is independent from Pi runtime hooks.

**Patterns to follow:**
- `formatChatGptQuota()` in `extensions/pi-coder-theme-editor.ts` for exported formatter coverage.
- Existing Vitest helper style in `extensions/pi-coder-theme-stale-context.test.ts`.

**Test scenarios:**
- Happy path: formatting a few seconds produces a seconds-only label.
- Happy path: formatting a minute-plus duration produces a compact minutes/seconds label such as `2m10s`.
- Happy path: formatting an hour-plus duration produces an hours/minutes label such as `1h30m`.
- Edge case: formatting an exact minute or exact hour does not produce awkward zero-value trailing units unless the chosen formatter convention intentionally includes them.
- Edge case: formatting negative, non-finite, or missing-like numeric values produces a safe fallback.

**Verification:**
- Formatter tests document the exact boundary behavior and pass without requiring a Pi UI session.

---

### U2. Wire agent lifecycle into elapsed-time state

**Goal:** Start, update, freeze, and clear elapsed-time state through the existing Pi lifecycle hooks.

**Requirements:** R1, R2, R3, R5, R7

**Dependencies:** U1

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-stale-context.test.ts`

**Approach:**
- In `before_agent_start`, clear any previous completed duration, record the new start time, reset frame state, and request a render through the existing working timer path.
- While the agent is active, compute elapsed time from the stored start timestamp rather than incrementing counters. This keeps the timer accurate even if render intervals drift.
- In `agent_end`, compute and store the final elapsed duration before stopping the working timer, then request render so the frozen label remains visible.
- In `session_shutdown`, clear active and completed elapsed-time state alongside existing timer teardown to avoid stale display after session replacement.
- Keep non-UI contexts guarded by the same `ctx.hasUI` principles already used in this extension.

**Patterns to follow:**
- Existing `isWorking`, `workingMessage`, `workingFrameIndex`, `workingTimer`, `startWorkingTimer()`, and `stopWorkingTimer()` patterns in `extensions/pi-coder-theme-editor.ts`.
- Existing lifecycle tests for working message transitions and active tool execution state in `extensions/pi-coder-theme-stale-context.test.ts`.

**Test scenarios:**
- Happy path: after `before_agent_start`, rendering the editor includes an active elapsed-time label.
- Happy path: after advancing fake time and firing `agent_end`, rendering still includes the final duration label even though `isWorking` is false.
- Integration: active tool execution still changes the working message to “Running tools...” while elapsed time continues to be shown.
- Edge case: `agent_end` without a valid active start does not throw and does not render an invalid duration.
- Edge case: `session_shutdown` clears any active/completed timer state and stops render timers.

**Verification:**
- Existing working-status behavior remains intact while new lifecycle tests prove the elapsed label transitions from active to completed.

---

### U3. Render elapsed time near the input box without disrupting editor chrome

**Goal:** Display elapsed time in the editor area in a width-safe way that coexists with the current status labels.

**Requirements:** R1, R2, R5, R6

**Dependencies:** U1, U2

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-command-palette.test.ts`

**Approach:**
- Add an elapsed-time label provider to `PiCoderThemeEditor`, similar to the existing `getWorkingState` injection, so render code remains deterministic and easy to test.
- Render the elapsed label through the existing status-row machinery on the left side, before the working message when active and as the sole left status item after completion.
- Use existing theme colors such as `muted`, `dim`, or `accent`; do not expand theme tokens for this small metadata label.
- Ensure the label is truncated or omitted before it causes narrow-terminal overflow. Existing `statusRows()`, `borderWithRightLabel()`, `visibleWidth`, and `truncateToWidth` utilities should be reused rather than duplicating width math.
- Preserve command palette popup rendering and fixed-editor compositor assumptions by keeping `render(width)` line counts predictable.

**Patterns to follow:**
- `getWorkingLabel()`, `getGitChangesLabel()`, `statusRows()`, and `borderWithRightLabel()` in `extensions/pi-coder-theme-editor.ts`.
- Render assertions in `extensions/pi-coder-theme-command-palette.test.ts` that strip ANSI before checking labels.
- `renderFixedEditorCluster()` in `extensions/fixed-editor/cluster.ts`, which assumes editor lines are already normalized to terminal width.

**Test scenarios:**
- Happy path: rendering an active elapsed-time state shows a compact label near the editor/input area.
- Happy path: rendering a completed elapsed-time state shows the frozen compact label after the working label disappears.
- Edge case: rendering at a narrow width does not produce any line whose visible width exceeds the requested width.
- Integration: context usage, token usage, model label, cwd label, working status, and git changes remain present or degrade according to the existing truncation behavior.
- Integration: command palette insertion/submission behavior is unaffected by the new label.

**Verification:**
- Editor render tests confirm the label appears in both active and completed states and all rendered lines remain width-safe.

---

### U4. Reset completed elapsed time when the user starts a new input

**Goal:** Clear the frozen completed duration only when the user begins entering new input content, not immediately on task completion.

**Requirements:** R2, R3, R5, R7

**Dependencies:** U2, U3

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-command-palette.test.ts`

**Approach:**
- Extend `PiCoderThemeEditor.handleInput()` so it can notify the extension when editor input meaningfully changes after a completed agent run.
- Compare editor text before and after delegating to `super.handleInput(data)` for normal keys, then clear completed elapsed time only when the resulting text differs or the action inserts/submits a command in a way that starts a new prompt path.
- Preserve the slash-command palette branch: opening the palette with `/` on an empty editor should not accidentally clear the completed duration until the user actually inserts/submits a command or otherwise changes input content.
- Request a render after clearing so the stale completed duration disappears promptly.

**Patterns to follow:**
- Existing `/` command-palette branch in `PiCoderThemeEditor.handleInput()`.
- `insertCommand()` and `submitCommand()` methods, which already centralize command palette mutations.
- Existing history restoration tests in `extensions/pi-coder-theme-command-palette.test.ts` for input-handling behavior.

**Test scenarios:**
- Happy path: after a completed agent run, typing a printable character clears the frozen elapsed-time label.
- Happy path: after a completed agent run, inserting a command from the command palette clears the label because editor content changes.
- Happy path: submitting a command from the command palette clears the label as a new prompt begins.
- Edge case: pressing navigation/history keys that do not change editor text does not clear the completed duration.
- Edge case: opening the command palette with `/` from an empty editor does not clear the label until a selection changes or submits content.
- Integration: existing history navigation behavior still restores previous prompts correctly.

**Verification:**
- Reset tests prove completed duration persists across idle renders and disappears only after meaningful new input.

---

## System-Wide Impact

- **Interaction graph:** The change touches only the custom editor extension's lifecycle hooks and render path. It should not affect tool rendering, assistant message rendering, user message rendering, thinking steps, or package registration.
- **Error propagation:** Timer state should never throw during render; invalid or missing timestamps should result in no label or a safe fallback.
- **State lifecycle risks:** The key lifecycle risk is stale completed duration after session replacement. Clearing state on `session_shutdown` and starting each agent run from a fresh timestamp mitigates this.
- **API surface parity:** No public API, CLI flag, command, config key, theme token, or session schema changes are planned.
- **Integration coverage:** Cross-layer tests should exercise event handlers plus editor render output because formatter tests alone do not prove the UI lifecycle behavior.
- **Unchanged invariants:** The custom editor must continue to call `super.handleInput(data)` for normal input and must continue hiding Pi's built-in working row as it does today.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Timer updates too frequently or adds unnecessary render work | Reuse the existing working animation interval while active; compute from wall-clock time instead of adding another interval. |
| Completed duration clears on harmless control keys | Compare editor text before/after input and clear only when content changes or a command is inserted/submitted. |
| Narrow terminal layouts overflow | Reuse existing truncation helpers and add width-safety tests for rendered lines. |
| Label placement crowds existing working/git status labels | Prefer existing status-row truncation behavior and allow the elapsed label to truncate or disappear before core editor content breaks. |
| Fake timers interact poorly with existing interval tests | Keep timer computation based on injectable/fakeable `Date.now()` behavior and restore timer mocks carefully in tests. |

---

## Documentation / Operational Notes

- README updates are optional for this first pass because the feature is a small UI affordance, but release notes should mention the new elapsed-time display when publishing.
- Manual verification in Pi is useful after tests pass because the exact visual placement is terminal-layout-sensitive.

---

## Sources & References

- Related code: `extensions/pi-coder-theme-editor.ts`
- Related tests: `extensions/pi-coder-theme-stale-context.test.ts`
- Related tests: `extensions/pi-coder-theme-command-palette.test.ts`
- Related layout helper: `extensions/fixed-editor/cluster.ts`
- Pi docs: `@earendil-works/pi-coding-agent` extension docs (`docs/extensions.md`)
- Pi docs: `@earendil-works/pi-coding-agent` TUI docs (`docs/tui.md`)
