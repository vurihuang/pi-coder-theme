# pi-coder-theme

[![npm version](https://img.shields.io/npm/v/pi-coder-theme)](https://www.npmjs.com/package/pi-coder-theme)
[![npm downloads](https://img.shields.io/npm/dm/pi-coder-theme)](https://www.npmjs.com/package/pi-coder-theme)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Coder Theme UI for [Pi](https://pi.dev): a Pi Coder Theme dark theme, rounded editor chrome, synchronized thinking-level colors, compact user messages, and bundled compact tool rendering.

![Pi Coder Theme preview](screenshots/pi-coder-theme-preview.png)

## Install

```bash
pi install npm:pi-coder-theme
```

Set the theme in Pi settings, or in `~/.pi/agent/settings.json`:

```json
{
  "theme": "pi-coder-theme-dark"
}
```

If `npm:pi-tool-display` is installed separately, remove it. `pi-coder-theme` already bundles it.

## Includes

- `pi-coder-theme-dark` theme
- Pi Coder Theme editor chrome with context, cost, ChatGPT subscription quota, model, thinking level, cwd, branch, and git change summary
- Working status integrated into the editor status row, with git changes kept on the right
- Fixed editor rendering keeps typing immediate by caching/debouncing status and widget updates separately from editor input
- Goal-Driven worker status in the editor status row when `pi-goal-driven` publishes structured runtime status events
- Compact Pi Coder Theme user messages with thinking-level color sync
- Structured thinking-step display for visible assistant reasoning
- Bundled `pi-tool-display`

Structured thinking display turns visible provider reasoning into terminal-native steps while preserving the original reasoning text. If Pi's assistant-message internals are incompatible with this package version, pi-coder-theme warns and leaves Pi's native thinking renderer in place for that session.

### Fixed editor performance model

The fixed editor uses an immediate editor-input lane and a cached status lane. Typing, cursor movement, editor popups, and command insertion request repaint immediately, while non-critical status fields such as git summary, token usage, cost, and quota are read from snapshots and refreshed asynchronously outside the editor render and lifecycle-event hot paths. Working/status animation ticks only invalidate status chrome, so they do not rescan session history or rerun git commands while you type.

ChatGPT quota display appears only for OpenAI/Codex models authenticated through Pi's subscription/OAuth login. It consumes subscription usage updates from `@marckrenn/pi-sub-core`, keeps the existing compact `5h … / W …` editor label, and refreshes through sub-core on the `chatGptQuota.refreshMinutes` interval from `config.json` (default 5 minutes). API-key sessions and unsupported providers do not show quota usage.

## Development

```bash
npm install
npm test
npm run typecheck
npm run check
npm run pack:check
```

For local Pi testing:

```bash
pi install .
```

Switch back to the published package when done:

```bash
pi remove .
pi install npm:pi-coder-theme
```

## Release

Use the bundled release skill/checklist:

```text
release-pi-coder-theme
```

At minimum:

```bash
npm run release:check
npm publish
```

See `CHANGELOG.md` for release notes.

## License

MIT
