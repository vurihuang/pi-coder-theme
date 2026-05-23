# Changelog

## Unreleased

- Remove the fixed-bottom editor compositor and restore Pi's native editor/widget/footer flow to reduce terminal hot-path overhead.
- Move git, token usage, and cost aggregation out of the editor render path and into asynchronous status snapshot refreshes.
- Keep editor chrome, status labels, command palette, structured thinking display, compact user messages, and bundled `pi-tool-display` intact.
- Rename retained editor status helpers out of the old fixed-editor namespace.

## 0.2.0

- Render structured Goal-Driven worker status in the editor status row when `pi-goal-driven` publishes `goal-driven:runtime-status` events.
- Show active worker attempt count and elapsed time with width-aware visual accents while preserving existing main-agent timing behavior.

## 0.1.0

Initial release.

- Add Pi Coder Theme dark/light themes, including the Gruvbox dark hard palette.
- Add Pi Coder Theme editor chrome with context usage, real session cost, model, thinking level, cwd, branch, and git change summary.
- Add working-state rendering for waiting, streaming, and tool execution, while hiding Pi's built-in loader when supported.
- Add user message rendering that stays synchronized with runtime thinking-level colors and extension reloads.
- Add an overlay command palette for built-in, extension, prompt, and skill slash commands.
- Add structured thinking-step rendering with deterministic parsing, width-aware terminal output, and native Pi renderer fallback.
- Show remaining ChatGPT subscription 5-hour and weekly quota percentages for `openai-codex` OAuth sessions, while hiding subscription quota usage for API-key sessions and unsupported providers.
- Bundle `pi-tool-display` for compact tool rendering.
- Include regression coverage for package metadata, theme tokens, editor behavior, command palette behavior, user message state, and thinking-step rendering.
