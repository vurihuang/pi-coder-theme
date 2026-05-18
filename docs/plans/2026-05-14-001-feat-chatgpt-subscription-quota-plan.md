---
title: feat: Add ChatGPT Subscription Quota Indicator
type: feat
status: active
date: 2026-05-14
---

# feat: Add ChatGPT Subscription Quota Indicator

## Summary

Add a compact ChatGPT subscription quota indicator to the existing pi-coder-theme editor top-left usage label, immediately after the current price/subscription marker. The indicator only appears for ChatGPT/OpenAI Codex models authenticated through OAuth subscription credentials; API-key models and unsupported providers remain unchanged.

---

## Problem Frame

The current pi-coder-theme editor already shows context, token usage, cost, and a `sub` marker, but subscription users still cannot see whether their short-window or weekly ChatGPT allowance is close to exhaustion. The referenced `pi-chatgpt-limit` project proves Pi extensions can use Pi's existing OAuth token to query ChatGPT quota windows and render `5h` / `W` usage inline.

---

## Requirements

- R1. Show ChatGPT subscription quota usage near the existing top-left usage/cost area, specifically to the right of the current price and `sub` display.
- R2. Show both short-window (`5h`) and weekly (`W`) quota percentages when both are available.
- R3. Hide quota display for API-key authentication and for providers without supported subscription quota integration.
- R4. Keep existing pi-coder-theme editor rendering, context usage, token usage, cost display, model label, and command palette behavior unchanged.
- R5. Fail quietly when quota data cannot be fetched or parsed; quota absence must not break editor rendering.
- R6. Defer Claude quota display until a separate follow-up because its available usage endpoint is less stable than ChatGPT's referenced endpoint.

---

## Scope Boundaries

- No Claude quota display in this first implementation.
- No user-facing configuration menu for choosing weekly vs 5h vs both; first version always displays both available ChatGPT windows compactly.
- No footer replacement work; this plan targets the existing pi-coder-theme editor top-left usage label.
- No changes to theme color tokens unless implementation discovers an existing token is unusable.
- No API-key quota display; OpenAI API usage/rate limits are a different surface from ChatGPT subscription limits.

### Deferred to Follow-Up Work

- Claude subscription quota support: evaluate the Anthropic OAuth usage endpoint stability and shape before adding provider support.
- Optional display preferences: hide/show windows, remaining-vs-used mode, or reset-time display can follow if users want configuration.

---

## Context & Research

### Relevant Code and Patterns

- `extensions/pi-coder-theme-editor.ts` owns the custom editor, including `PiCoderThemeEditor.getUsageLabel()`, `getSessionCost()`, and top-left label rendering.
- `extensions/pi-coder-theme.test.ts` already enforces package namespace and extension source checks; it is the right place for broad package-level assertions if needed.
- New focused tests should live alongside the editor code, e.g. `extensions/pi-coder-theme-editor.test.ts`, so quota parsing/formatting can be covered without rendering a full Pi session.
- Reference project: `patlux/pi-chatgpt-limit` implements ChatGPT quota fetching with `ctx.modelRegistry.isUsingOAuth(model)`, `ctx.modelRegistry.getApiKeyAndHeaders(model)`, and `GET https://chatgpt.com/backend-api/wham/usage`.

### Institutional Learnings

- No `docs/solutions/` learnings exist in this repository.

### External References

- `https://github.com/patlux/pi-chatgpt-limit` for ChatGPT quota endpoint usage, window parsing, OAuth-token metadata extraction, and compact display examples.
- Pi docs expose custom editor/footer APIs and confirm `modelRegistry.isUsingOAuth(model)` identifies subscription/OAuth credentials.

---

## Key Technical Decisions

- Extend `extensions/pi-coder-theme-editor.ts` instead of replacing the footer: the requested placement is in the existing top-left editor usage label, and this avoids competing with the package's current custom editor/footer behavior.
- Gate quota fetching on both provider and OAuth auth: provider matching prevents unsupported models from calling ChatGPT endpoints, while `isUsingOAuth` prevents API-key users from seeing subscription-only UI.
- Start with ChatGPT/OpenAI Codex only: the referenced project provides a concrete endpoint and parsing model; Claude support remains deferred until its endpoint contract is validated.
- Keep quota fetch state outside render methods: rendering should consume a cached snapshot and never perform network work.
- Display compact used percentages only: `5h 42% / W 18%` is enough for first-version awareness and fits the existing dense status label.

---

## Open Questions

### Resolved During Planning

- Should Claude be included in the first version? Resolved: no, start with ChatGPT and defer Claude.
- Where should the quota appear? Resolved: top-left editor usage label, to the right of price and `sub`.

### Deferred to Implementation

- Exact provider-name matching for all ChatGPT subscription models: implementation should inspect current Pi model provider IDs and mirror the reference project's `openai-codex` pattern where applicable.
- Exact color threshold styling: implementation can reuse existing `warning`, `error`, and `muted/text` tokens after seeing the final label density.

---

## Implementation Units

### U1. Extract ChatGPT quota parsing and formatting helpers

**Goal:** Add testable helper logic for recognizing ChatGPT quota windows and formatting compact display text.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-editor.test.ts`

**Approach:**
- Introduce small helper types for quota windows and quota snapshots near the existing usage/cost helpers.
- Parse ChatGPT `rate_limit.primary_window` / `secondary_window` records into `fiveHour` and `weekly` windows by matching 5-hour and 7-day window durations with a small tolerance.
- Format available windows as compact text with stable labels: `5h <used>%` and `W <used>%`, joined only when values exist.
- Keep helpers pure so tests do not require Pi runtime objects.

**Patterns to follow:**
- Existing `formatCount()`, `formatCost()`, and `formatTokenUsage()` helper style in `extensions/pi-coder-theme-editor.ts`.
- Reference parser in `pi-chatgpt-limit` for tolerant window matching and percent clamping.

**Test scenarios:**
- Happy path: ChatGPT usage payload with a 5-hour primary window and weekly secondary window -> formatted label includes both `5h` and `W` percentages.
- Happy path: payload with only weekly data -> formatted label includes only `W` percentage and omits dangling separators.
- Edge case: percentages below 0 or above 100 -> display clamps to the 0-100 range.
- Edge case: unknown window durations -> no quota label is produced.
- Error path: malformed or missing `rate_limit` object -> parsing returns no displayable quota without throwing.

**Verification:**
- Quota parser and formatter tests pass without requiring network access.
- Existing editor helper tests and TypeScript checks continue to pass.

---

### U2. Fetch and cache ChatGPT subscription quota snapshots

**Goal:** Query ChatGPT quota data only for supported OAuth subscription models and store the latest displayable snapshot for the editor.

**Requirements:** R2, R3, R5

**Dependencies:** U1

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-editor.test.ts`

**Approach:**
- Add module-level quota state similar to existing working/git state, but scoped to the active session/model lifecycle.
- On `session_start`, `model_select`, and `agent_end`, queue a background quota refresh for eligible ChatGPT subscription models.
- Use `ctx.modelRegistry.isUsingOAuth(model)` before requesting credentials, and clear quota state immediately for API-key or unsupported providers.
- Use `ctx.modelRegistry.getApiKeyAndHeaders(model)` to retrieve the OAuth token and call ChatGPT's usage endpoint with a timeout.
- Decode token metadata only if needed for account headers; failures should clear quota state and request a render rather than notifying users.
- Serialize refreshes through a simple in-flight promise so model changes or agent completions do not create overlapping fetch races.

**Patterns to follow:**
- Existing event registration and render invalidation pattern in `extensions/pi-coder-theme-editor.ts`.
- Reference project's `queueUpdate`, `updateUsage`, provider guard, OAuth-token fetch, and silent-failure behavior.

**Test scenarios:**
- Happy path: supported ChatGPT provider using OAuth with a valid mocked usage response -> cached snapshot updates and render is requested.
- Edge case: API-key authentication for an otherwise supported provider -> fetch is skipped and quota state is cleared.
- Edge case: unsupported provider such as Claude in first version -> fetch is skipped and no quota label is available.
- Error path: credential lookup fails or returns no token -> quota state clears without throwing.
- Error path: usage endpoint returns non-OK or malformed JSON -> quota state clears without user-visible notification.
- Integration: repeated refresh triggers while one refresh is in flight -> final state is consistent and no unhandled promise rejection occurs.

**Verification:**
- Tests prove quota fetching is gated by OAuth subscription auth and provider support.
- Failed quota refreshes do not affect existing editor render output beyond omitting the quota label.

---

### U3. Render quota next to the existing price/sub marker

**Goal:** Add the cached quota label to the top-left usage label without disturbing the existing context, token, cost, and subscription display.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** U1, U2

**Files:**
- Modify: `extensions/pi-coder-theme-editor.ts`
- Test: `extensions/pi-coder-theme-editor.test.ts`

**Approach:**
- Extend `PiCoderThemeEditor.getUsageLabel()` so the quota label is appended immediately after the cost/sub segment when one exists.
- If there is no cost/sub segment but a quota snapshot exists for an eligible subscription model, still place quota after the existing context/token segments in the same top-left label.
- Use existing truncation behavior from `borderWithLabels()` rather than adding separate width logic.
- Apply color only through existing theme tokens and keep the raw text compact enough for narrow terminals.

**Patterns to follow:**
- Existing `getUsageLabel()` part assembly, which already uses ` · ` separators.
- Existing top border label truncation in `PiCoderThemeEditor.borderWithLabels()`.

**Test scenarios:**
- Happy path: context + token + `$0.000 sub` + quota -> label orders quota after the subscription marker.
- Happy path: eligible subscription with quota but no token usage yet -> label still includes context and quota without malformed separators.
- Edge case: no quota snapshot -> label exactly matches existing behavior for context/tokens/cost.
- Edge case: narrow render width -> output remains truncated by existing border logic rather than overflowing.
- Integration: switching from ChatGPT OAuth to API-key or unsupported provider removes the quota on the next render.

**Verification:**
- Snapshot or string-level tests cover label ordering and separator behavior.
- Existing command palette and editor render tests still pass.

---

### U4. Document first-version behavior and release implications

**Goal:** Make the feature discoverable and set clear expectations that Claude support is deferred.

**Requirements:** R3, R6

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `extensions/pi-coder-theme.test.ts`

**Approach:**
- Document that ChatGPT/OpenAI Codex OAuth subscription users see compact `5h` and `W` usage in the editor chrome.
- State that API-key users and unsupported providers do not show quota information.
- Mention Claude quota support as not included in this release if the README has a suitable limitations or notes section.
- Keep package metadata unchanged unless implementation introduces a new runtime dependency, which this plan does not expect.

**Patterns to follow:**
- Existing README package setup and feature description style.
- Existing CHANGELOG version-entry style.

**Test scenarios:**
- Test expectation: none for README/CHANGELOG prose beyond existing package/source assertions; no behavior changes live in documentation.

**Verification:**
- Documentation accurately reflects the implemented provider/auth gating.
- Package dry-run still includes README, CHANGELOG, extensions, themes, and skills.

---

## System-Wide Impact

- **Interaction graph:** New quota refresh hooks attach to `session_start`, `model_select`, and `agent_end`; editor render consumes cached state only.
- **Error propagation:** Network, auth, parse, and endpoint failures should collapse to “no quota label” and never notify unless implementation later adds an explicit diagnostics command.
- **State lifecycle risks:** Model switches must clear stale quota state before fetching for the new model so a previous ChatGPT quota never appears for Claude or API-key sessions.
- **API surface parity:** This feature affects only interactive editor chrome; RPC/no-UI modes should be unaffected because editor setup already checks `ctx.hasUI`.
- **Integration coverage:** Tests should cover the provider/auth gate and render label ordering because helper tests alone would not prove the quota appears in the requested location.
- **Unchanged invariants:** Existing context usage, token usage, cost display, model label, git status, working indicator, and command palette behavior should remain unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| ChatGPT usage endpoint is undocumented and may change | Isolate parsing/fetching helpers, fail quietly, and keep display optional. |
| OAuth credential access differs across Pi versions | Use existing `modelRegistry` methods already used by reference projects and guarded with TypeScript-compatible narrow casts where needed. |
| Stale quota display after model switch | Clear snapshot immediately for unsupported/API-key models before any async fetch. |
| Dense top-left label becomes too long | Keep compact `5h` / `W` labels and rely on existing border truncation. |
| Tests become coupled to Pi runtime internals | Keep parser/formatter pure and mock only the narrow modelRegistry/fetch behavior for integration-like tests. |

---

## Documentation / Operational Notes

- No new secrets or config files are expected.
- The feature calls ChatGPT's backend usage endpoint using Pi's existing OAuth token, so README should communicate that it is subscription-only and local-extension behavior.
- Release verification should include `npm run typecheck`, `npm test`, `npm run check`, and `npm run pack:check` because this touches extension UI and package-facing docs.

---

## Sources & References

- Reference package: `https://github.com/patlux/pi-chatgpt-limit`
- Related code: `extensions/pi-coder-theme-editor.ts`
- Related tests: `extensions/pi-coder-theme.test.ts`, `extensions/pi-coder-theme-editor.test.ts`
- Pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
