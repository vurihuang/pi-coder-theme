---
date: 2026-05-23
topic: input-render-simplification
---

# Input Render Simplification

## Summary

Simplify the editor input rendering and status refresh code now that the fixed input box behavior has been removed. The goal is to remove stale timing workarounds that were only needed for the fixed-input presentation, while preserving responsive typing, command palette behavior, and status bar freshness.

---

## Problem Frame

The current editor code still carries several timing and repaint safeguards that were added to keep the fixed input box fresh and resilient during unusual render timing. With that UI shape gone, some of this machinery may now add complexity without enough value: input events mark status timing, no-op inputs schedule multiple follow-up renders, and status refreshes defer around recent input.

The risk is removing too much and reintroducing flicker, stale typed text, delayed command palette updates, or stale status rows. The cleanup should therefore be incremental and evidence-driven.

---

## Actors

- A1. Pi user: Types prompts, uses command shortcuts, pastes content, and expects the editor to repaint immediately.
- A2. Theme maintainer: Needs the extension code to stay small enough to reason about and safe to release.
- A3. Downstream planner/implementer: Needs clear boundaries for what can be simplified versus what should remain.

---

## Requirements

**Input repaint behavior**
- R1. Typing normal text must still repaint the editor immediately and clear completed elapsed-time status when text changes.
- R2. Cursor movement, command palette triggers, paste-related input, and other no-text-change inputs must not leave the visible editor stale.
- R3. Any retained async repaint fallback must be narrower than the current multi-timer blanket behavior, unless verification proves the blanket behavior is still required.

**Status refresh behavior**
- R4. Status bar updates should continue to debounce/coalesce repeated status invalidations.
- R5. Status refresh scheduling should no longer depend on recent editor input unless a current reproducible issue proves that dependency is still needed.
- R6. Status data snapshotting should remain asynchronous enough to avoid doing expensive session/git/cost reads during render.

**Complexity reduction**
- R7. Remove or rename input-timing helpers whose remaining purpose is only body invalidation, so the code describes what it actually does.
- R8. Preserve editor body caching unless a follow-up verification shows it is no longer needed and can be removed without regressions.
- R9. Delete or update tests that specifically assert fixed-input-era timing behavior after the behavior is intentionally simplified.

---

## Acceptance Examples

- AE1. **Covers R1.** Given the editor is idle with a completed elapsed-time label visible, when the user types `h`, the typed text appears on the next render and the completed elapsed-time label is cleared.
- AE2. **Covers R2, R3.** Given the user sends a key sequence that does not immediately change text but may affect editor state, when the key is handled, the editor requests at least one repaint without scheduling unnecessary repeated repaint timers.
- AE3. **Covers R4, R5.** Given several status invalidations happen close together after typing, when the debounce window expires, they produce one status render without extending the delay because input happened recently.
- AE4. **Covers R6.** Given a render occurs before async status data collection completes, when the editor renders, it uses safe fallback/snapshot data instead of synchronously recomputing expensive fields.

---

## Success Criteria

- The input/render code is lighter: fewer timers, fewer input-specific scheduler fields, and clearer helper names.
- Existing editor behavior remains stable for typing, slash command palette, paste/autocomplete-style inputs, status rows, and elapsed-time display.
- `npm run typecheck` and `npm test -- --run` pass after the cleanup.
- A downstream implementer can identify which pieces are safe to simplify now and which are intentionally deferred.

---

## Scope Boundaries

- In scope: simplifying input repaint timing, status scheduler input deferral, related tests, and naming around editor body invalidation.
- In scope: retaining behavior covered by current tests or adding focused tests where simplification changes expected timing.
- Out of scope: redesigning the editor chrome, changing visual styling, changing command palette UX, or removing status data snapshotting entirely.
- Out of scope: broad refactors of git/cost/quota/session status collection beyond what is necessary to decouple it from input timing.

---

## Key Decisions

- Treat `StatusRenderScheduler` input deferral as the primary simplification candidate because the fixed input box no longer needs status refreshes to wait around recent input.
- Treat the multi-delay async input repaint fallback as a likely historical workaround; reduce it before deleting it outright unless verification proves deletion is safe.
- Keep editor body caching for now because it protects render performance and popup/body splitting independently of the removed fixed-input behavior.
- Keep async status data snapshots because they prevent expensive data reads from happening inside render.

---

## Dependencies / Assumptions

- The fixed input box logic has already been removed from the current codebase.
- Relevant current code lives under `extensions/pi-coder-theme-editor.ts` and `extensions/editor-status/status-render-scheduler.ts`.
- Existing tests in `extensions/pi-coder-theme-command-palette.test.ts`, `extensions/pi-coder-theme-stale-context.test.ts`, and `extensions/editor-status/status-render-scheduler.test.ts` cover the main regression surface.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2, R3][Technical] Which no-text-change input paths still rely on async updates from the base editor, if any?
- [Affects R5][Technical] Was input-based status deferral only for the fixed input box, or does it still prevent a reproducible status/editor race in the current UI?
- [Affects R8][Technical] Can editor body caching be removed later without causing unnecessary `super.render()` work on status ticks?
