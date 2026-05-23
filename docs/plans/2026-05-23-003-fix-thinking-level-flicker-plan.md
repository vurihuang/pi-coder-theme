---
title: "fix: eliminate TUI flicker on thinking level switch"
type: fix
status: completed
created: 2026-05-23
depth: lightweight
---

# fix: eliminate TUI flicker on thinking level switch

## Problem Frame

When the user cycles thinking levels (e.g., `off → minimal → low`), the editor border color updates immediately, but the status bar thinking label and all user message `▌` prefix colors lag ~80ms behind. This two-frame gap produces a visible flicker — the UI briefly shows the old thinking color on the status bar and user messages while the border already reflects the new level.

## Root Cause

The event flow for a thinking level switch is:

1. **Sync**: `thinking_level_changed` fires → `interactive-mode` calls `updateEditorBorderColor()` → `requestRender()` — border color lands in frame 1
2. **Async (microtask)**: `thinking_level_select` fires → extension handler calls `invalidateStatus("status")` → `StatusRenderScheduler.markDirty()` schedules with **80ms debounce** → frame 2 fires ~80ms later with updated status bar and user message colors

The 80ms `debounceMs` in `StatusRenderScheduler` was designed for periodic status updates (git info, token usage) where batching is beneficial. But thinking level changes are discrete user actions that need all visual updates in one frame.

## Key Technical Decision

Use `forceStatusRefresh("status")` instead of `invalidateStatus("status")` in the `thinking_level_select` handler. `forceStatusRefresh` calls `statusScheduler.forceRefresh()` which flushes immediately (calls `onRender` → `requestRender()` within the same microtask), merging with frame 1.

This preserves the debounce behavior for periodic status updates while ensuring discrete user actions render atomically.

---

## Scope Boundaries

**In scope:**
- Fix the two-frame render gap on thinking level switch (editor extension only; user message extension requires no code change — it piggybacks on the editor's render trigger)

**Out of scope:**
- Refactoring `StatusRenderScheduler` architecture
- Optimizing other event handlers (model switch already uses `forceStatusRefresh`)
- Changes to pi-tui render pipeline or `MIN_RENDER_INTERVAL_MS`

---

## Implementation Units

### U1. Use immediate refresh in thinking_level_select handlers

**Goal:** Eliminate the 80ms debounce for thinking level changes so all visual updates land in one TUI frame.

**Dependencies:** None

**Files:**
- `extensions/pi-coder-theme-editor.ts`

**Approach:**

In `pi-coder-theme-editor.ts`, the `thinking_level_select` handler currently calls `invalidateStatus("status")` which routes through the 80ms debounce. Change it to call `forceStatusRefresh("status")` instead, which flushes the scheduler immediately.

In `pi-coder-theme-user-message.ts`, the `thinking_level_select` handler only updates `activeThinkingLevel` and does not trigger any render. The user message color updates happen because `render()` reads `activeThinkingLevel` at render time — so the color changes only when a subsequent render is triggered. Since the editor extension's `forceStatusRefresh` will trigger `requestRender()`, the user message colors will also update in the same frame. No change needed here.

**Patterns to follow:** The `model_select` handler in `pi-coder-theme-editor.ts` already uses `forceStatusRefresh("status")` for the same reason — discrete user actions need immediate visual feedback.

**Test scenarios:**
- Cycle thinking level: verify status bar label and editor border color update in the same render cycle (no intermediate frame with mismatched colors)
- Switch thinking level via selector popup: verify same single-frame update
- Verify periodic status updates (git info, token usage) still use the 80ms debounce path (no regression)

**Verification:** `npm run typecheck` passes. Visual test: cycle thinking levels rapidly and confirm no color mismatch flash between border and status bar.

---

## Verification

- `npm run typecheck` passes
- `npm run check` passes
- Manual: cycle thinking levels — no flicker between border and status colors
