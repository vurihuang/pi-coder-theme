---
name: configure-pi-coder-theme
description: Use when configuring, installing, updating, troubleshooting, or switching themes for the pi-coder-theme Pi UI package, especially pi-coder-theme-dark or conflicts with pi-tool-display.
---

# Configure pi-coder-theme

## Overview

`pi-coder-theme` is a Pi UI package. It provides Pi Coder Theme editor chrome, bundled compact tool display, and the `pi-coder-theme-dark` theme.

Goal: make the package load once, avoid renderer conflicts, and set the intended theme.

## Quick setup

Install the package:

```bash
pi install npm:pi-coder-theme
```

Set the theme in `~/.pi/agent/settings.json`:

```json
{
  "theme": "pi-coder-theme-dark"
}
```

Or use Pi's interactive settings:

```text
/settings → Theme → pi-coder-theme-dark
```

## Conflict cleanup

`pi-coder-theme` bundles `pi-tool-display`. Do not load standalone `npm:pi-tool-display` at the same time.

Check packages:

```bash
pi list
```

If standalone `pi-tool-display` is present, remove it:

```bash
pi remove npm:pi-tool-display
```

If an old local package appears in settings, remove it from `~/.pi/agent/settings.json`:

```text
packages/pi-coder-theme-agent-ui
```

Keep this package entry:

```text
npm:pi-coder-theme
```

## Update

```bash
pi update npm:pi-coder-theme
```

## Verify

Run a smoke test:

```bash
pi -p "Reply with ok"
```

For interactive UI verification, start Pi and check startup resources show:

```text
[Extensions]
  pi-coder-theme:pi-coder-theme-editor.ts
  pi-coder-theme:node_modules/pi-tool-display

[Themes]
  pi-coder-theme-dark
```

The editor should show Pi Coder Theme rounded editor chrome with context usage, model id, thinking level, cwd, and branch. The input area uses Pi's native placement; it is not pinned by a custom fixed-bottom compositor.

## Common issues

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tool renderer conflict | `npm:pi-tool-display` loaded separately | `pi remove npm:pi-tool-display` |
| Theme not found | Old theme name or package not installed | Use `pi-coder-theme-dark`; run `pi install npm:pi-coder-theme` |
| Editor chrome not showing | Extension disabled or package filtered | Check `pi list` and `~/.pi/agent/settings.json` package filters |
| Old `pi-coder-theme-agent` theme missing | Theme was renamed before general use | Set theme to `pi-coder-theme-dark` |

## Do not

- Do not install standalone `npm:pi-tool-display` together with `pi-coder-theme`.
- Do not keep old `packages/pi-coder-theme-agent-ui` in settings.
- Do not set theme to `pi-coder-theme-agent`; use `pi-coder-theme-dark`.
