# Repository Guidelines

## Project Structure & Module Organization

- `facebook-reaction-blocker.user.js` is the complete Tampermonkey userscript: metadata, Facebook DOM discovery, queue processing, persistence, and panel UI.
- `tests/smoke.mjs` is the Playwright smoke suite. It builds synthetic Czech Facebook dialogs; never use real profile data in fixtures.
- `README.md` contains user installation and operation instructions. `CHANGELOG.md` records released behavior by userscript version.
- There is no build output or generated source. Keep the userscript directly installable from its raw GitHub URL.

## Build, Test, and Development Commands

Run commands from the repository root:

```powershell
node --check .\facebook-reaction-blocker.user.js
node --check .\tests\smoke.mjs
node .\tests\smoke.mjs
git diff --check
```

The first two commands validate JavaScript syntax. The smoke test exercises scanning, filtering, settings persistence, queue isolation, and safe action selectors. It requires Playwright plus Chrome or Edge. If they are not discovered automatically, set `FDB_NODE_MODULES` to a directory containing Playwright and `FDB_CHROME_PATH` to the browser executable.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, semicolons, and modern JavaScript. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and `fdb-` prefixes for DOM IDs and storage keys. Keep selectors conservative and support both Czech and English Facebook labels. No formatter or linter is configured; match the surrounding code.

## Testing Guidelines

Extend `tests/smoke.mjs` for every selector, persistence, queue, or safety change. Use deterministic synthetic DOM fixtures and descriptive assertion errors. Test both the expected match and a nearby false-positive case. Never let a test trigger real Facebook actions.

## Commit & Pull Request Guidelines

History uses short imperative summaries such as `fix blocking dialog` and `enable autoupdate`. Keep each commit focused.

For every release, update all three version records in the same commit: the userscript `@version`, the version shown in the panel, and the matching entry in `CHANGELOG.md`. Never publish a version without documenting its changes.

Pull requests should explain the user-visible change, safety implications, and validation commands. Link the relevant issue when available and include a screenshot for panel changes. Do not include profile names, URLs, logs, tokens, or other personal data.

## Safety & Persistence

Operate only on the reaction dialog selected by the user and fail closed when Facebook markup is ambiguous. Preserve per-tab queue state in `sessionStorage`; store only reusable preferences through Tampermonkey storage. Keep explicit confirmation gates and trusted-host checks intact.
