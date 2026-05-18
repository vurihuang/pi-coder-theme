# Repository Guidelines

Maintainer: Frank.

## Project Structure & Module Organization

This package ships an Pi Coder Theme Pi UI bundle. Theme assets live in `themes/`, currently `themes/pi-coder-theme-dark.json`. Pi extension code lives in `extensions/`, including editor chrome and user message rendering. Agent-facing setup guidance lives in `skills/configure-pi-coder-theme/SKILL.md`. Package metadata, Pi registration, and scripts are in `package.json`; TypeScript settings are in `tsconfig.json`.

## Build, Test, and Development Commands

- `npm install`: install dependencies and bundled package inputs.
- `npm run typecheck`: run `tsc --noEmit` against `extensions/**/*.ts`.
- `npm run check`: load this package with Pi using `pi --no-extensions --no-themes -e . -p 'Reply with ok'`.
- `npm run pack:check`: inspect the npm package contents with `npm pack --dry-run`.
- `npm run release:check`: run typecheck, Pi load check, and package dry run before publishing.
- `mise run check` or `mise run release-check`: use the pinned Node version from `.mise.toml`.

## Coding Style & Naming Conventions

Use TypeScript ESM and strict typing for extension code. Keep indentation at two spaces in TypeScript and JSON. Prefer small helper functions near the behavior they support, and keep Pi API integration in extension entrypoints. Use descriptive kebab-case filenames for package-facing assets, such as `pi-coder-theme-dark.json`, and `pi-coder-theme-*` names for bundled Pi extensions.

## Testing Guidelines

There is no separate unit test suite yet. Treat `npm run typecheck` and `npm run check` as the minimum validation for every change. For theme-only edits, also run `npm run pack:check` to confirm package contents. For extension behavior changes, manually verify through Pi when practical, especially layout, truncation, and terminal-width behavior.

## Commit & Pull Request Guidelines

Git history uses Conventional Commit-style subjects such as `feat: add pi-coder-theme suite`, `fix: avoid duplicate theme load in check`, and `chore: release 0.2.2`. Keep commits focused on one concern. Pull requests should summarize user-visible changes, list verification commands run, and include screenshots or terminal captures when UI rendering changes. Link related issues when available and call out release or packaging impacts.

## Security & Configuration Tips

Do not commit local Pi settings or credentials. Keep `.npmrc` behavior intentional; this repo uses `legacy-peer-deps=true` because current Pi package peer ranges can lag compatible runtime versions. Before publishing, confirm `npm pack --dry-run` includes `README.md`, `CHANGELOG.md`, `LICENSE`, `extensions`, `themes`, `skills`, and the bundled `pi-tool-display` dependency.
