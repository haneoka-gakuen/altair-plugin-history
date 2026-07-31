# Contributing

Use Node.js 20 or newer and pnpm 11. Run `pnpm check` before opening a change.

Keep histories bounded, JSON-only, framework-neutral and mutation-isolated.
Add tests for source-document fidelity, gesture merging, capacity, revisions,
invalid values and lifecycle changes. Do not import Altair's legacy history
implementation or add SDKs, binaries, models, game assets or extracted
content.

Maintainers publish from GitHub releases through npm trusted publishing. The
npm package must authorize this repository's `.github/workflows/publish.yml`
workflow before the first release.
