# CLAUDE.md

See [AGENTS.md](AGENTS.md) for repo layout, runbook, quality gate, and CI pipeline.

## Quick Reference

```bash
# Dev
npm run tauri:dev              # full app (frontend + Rust + sidecar)
npm run dev                    # frontend only (Vite on :1420)
npm --prefix sidecar run dev   # sidecar only (tsx)

# Build
npm --prefix sidecar run build # sidecar TypeScript
npm run build                  # frontend TypeScript + Vite
npm run tauri:build:mac        # full macOS app + DMG

# Test
npm --prefix sidecar run test  # sidecar vitest
npm run test                   # frontend vitest

# Lint & Format
npm run lint                   # ESLint (zero warnings enforced)
npm run lint:fix               # ESLint with auto-fix
npm run format:check           # Prettier check
npm run format                 # Prettier write
```

## Code Conventions

### TypeScript
- Strict mode in both frontend and sidecar tsconfigs.
- Frontend: `module: "ESNext"`, `moduleResolution: "Bundler"` — no `.js` extensions on imports.
- Sidecar: `module: "NodeNext"`, `moduleResolution: "NodeNext"` — **always use `.js` extensions** on relative imports (e.g., `import { foo } from './bar.js'`).
- Use `import type` for type-only imports.
- Prefix unused parameters with `_` (e.g., `_outputPath`). ESLint enforces zero warnings.

### File Naming
- React components: `PascalCase.tsx` (e.g., `AppShell.tsx`, `GlowCard.tsx`).
- Everything else: `camelCase.ts` (e.g., `workspaceManager.ts`, `failureDoctor.ts`).
- Tests: `*.test.ts` / `*.test.tsx`, co-located in `src/__tests__/` (frontend) or `sidecar/tests/` (sidecar).

### Style
- Single quotes, trailing commas, semicolons, 120 char print width, 2-space indent.
- Arrow parens: `avoid` (i.e., `x => x` not `(x) => x`).
- Prefer `export function` over `export const fn = () =>` for top-level functions.
- Keep Slack-facing messages concise and human — no verbose logs or ceremony.

## Pre-commit Hooks

Husky + lint-staged runs on every commit:
1. `eslint --fix --max-warnings 0` on staged `*.{ts,tsx}` files.
2. `prettier --write` on staged `*.{ts,tsx}` files.

If the hook fails, fix the issue and create a **new** commit (don't amend).

## Sidecar Architecture

The sidecar (`sidecar/src/`) is a long-running Node.js process supervised by Tauri:

| Directory | Purpose |
|-----------|---------|
| `slack/` | Socket Mode client, thread context fetching |
| `router/` | Intent parsing, task routing, repo classification |
| `workflows/` | PR review, bug fix, implementation, conversational, dev-assist |
| `agents/` | Multi-agent pipeline: planner, coder, reviewer, security, performance, verifier |
| `backends/` | Claude Code, Codex backend interfaces |
| `codex/` | Codex execution, model profiles, prompt building |
| `learning/` | Self-learning engine, failure doctor, personality profiles |
| `state/` | SQLite job store, active jobs registry |
| `github/` | GitHub auth, PR creation, diff fetching |
| `workspaces/` | Git worktree isolation for pipeline runs |
| `types/` | Shared contracts, Zod schemas |

## Version Bumping

Use the script — it edits all four files, branches off the latest `origin/main`, commits, pushes, and opens (optionally merges) the PR:

```bash
node scripts/bump-version.mjs [patch|minor|major|X.Y.Z] [--merge] [--dry-run]
# e.g. node scripts/bump-version.mjs patch --merge
```

`--dry-run` validates the four edits without touching anything; `--merge` squash-merges the PR and syncs `main`. It aborts on uncommitted tracked changes. Branch convention: `chore/bump-v{X.Y.Z}`.

The four files it keeps in sync (if ever bumping by hand): `package.json` `"version"`, `src-tauri/Cargo.toml` `version`, `src-tauri/Cargo.lock` `version` under `[[package]] name = "watchtower"`, `src-tauri/tauri.conf.json` `"version"`.
