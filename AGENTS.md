# AGENTS.md

## Core Execution Protocol

IMPORTANT: Before starting ANY task, call `nexus_session_bootstrap` first.
After bootstrap, call `nexus_orchestrate` with the user's request.
Do NOT skip these steps. Do NOT manually explore files instead.

```bash
nexus_session_bootstrap(goal="<user request>", files=[optional candidate files])
nexus_orchestrate(prompt="<user request>")
```

### Lifecycle Hooks (required)
- **Before reading 3+ files**: `nexus_optimize_tokens(goal="<what you're doing>", files=[...])`
- **Before any file modification or destructive operation**: `nexus_mindkit_check(action="<what you're about to do>", filesToModify=[...])`
- **Before refactoring 3+ files**: `nexus_ghost_pass(goal="<what you're changing>", files=[...])`
- **After significant findings**: `nexus_store_memory(content="<learning>", priority=0.8, tags=["#bug", "#architecture"])`
- **Session end**: `nexus_store_memory(content="Session YYYY-MM-DD: <summary>", priority=0.85, tags=["#session-summary"])`
  `nexus_session_dna(action="generate")`

---

## Build / Lint / Test Commands

| Target | Command | Description |
|--------|---------|-------------|
| **Build** | `npm run build` | Produces production bundle. Must exit with zero errors. |
| **Type‑check** | `npx tsc --noEmit` | Ensures TypeScript compiles cleanly. |
| **Lint** | `npm run lint` | Runs ESLint with `--max-warnings=0`. Fails on any warning. |
| **All tests** | `npm test` | Runs Jest/Vitest test suite. All tests must pass. |
| **Single test** | `npm test -- -t "<test name>"` | Executes a single test matching the provided name (regex). |
| **Coverage** | `npm test -- --coverage` | Generates coverage report; project rule: ≥80% total coverage. |
| **Watch mode** | `npm test -- --watch` | Continuous testing during development. |

---

## Code Style Guidelines

### General Principles
- Write **readable**, **self‑documenting** code.
- Keep functions ≤ **50 lines**; long functions should be split.
- Limit files to **500 lines**; consider module boundaries.
- Prefer **explicit types**; avoid `any` unless a comment justifies it.
- All exported symbols must have **JSDoc**/**TSDoc** comments describing purpose, params, and return types.
- Use **strict mode** (`"use strict"`) and enable `strict` in `tsconfig.json`.

### Imports & Ordering
1. **Side‑effect imports** (e.g., polyfills) → top.
2. **External packages** – sorted alphabetically.
3. **Internal aliases** (e.g., `@/utils/*`) – grouped together.
4. **Relative imports** – sorted by path depth.
5. Separate each group with a blank line.

```ts
// side‑effects
import "reflect-metadata";

// external
import type { Request, Response } from "express";
import { mapValues } from "lodash";

// internal
import { logger } from "@/utils/logger";
import { getUser } from "@/services/user";

// relative
import config from "./config";
```

### Formatting
- Use **Prettier** with 2‑space indentation.
- **Semicolons** are required.
- **Trailing commas** in multi‑line objects/arrays.
- **Single quotes** for strings, backticks only for interpolation.

### Naming Conventions
- **Variables & functions**: `camelCase`.
- **Constants**: `UPPER_SNAKE_CASE`.
- **Classes & Types**: `PascalCase`.
- **Enums**: `PascalCase` with `UPPER_SNAKE_CASE` members.
- **Files**: kebab-case (`user-service.ts`).

### Types & Interfaces
- Prefer **interfaces** for object shapes used in multiple places.
- Use **type aliases** for unions, tuples, and primitives.
- All public functions must declare **return types** explicitly.
- Mark async functions with `Promise<...>` return type.
- Avoid using `any`; if unavoidable, add a comment explaining why.

### Error Handling
- Wrap all **async/await** calls in `try/catch` blocks.
- Create custom error classes extending `Error` for domain‑specific failures.
- Log errors with stack trace and context before re‑throwing.
- Never swallow errors silently; always propagate or handle.

```ts
try {
  const user = await getUser(id);
  return user;
} catch (err) {
  logger.error('Failed to fetch user', { id, err });
  throw new UserNotFoundError(id);
}
```

### Testing Guidelines
- Place tests alongside source files in `__tests__` folders or with `.test.ts` suffix.
- Use **describe** blocks to group related tests.
- Aim for **unit‑test coverage ≥80%**; integration tests cover critical flows.
- Mock external services; never hit real APIs in unit tests.
- Use **snapshot testing** sparingly; only for stable UI output.

### Lint / Formatter Configuration
- **ESLint**: extends `eslint:recommended`, `plugin:@typescript-eslint/recommended`, `prettier`.
- **Prettier**: 2‑space indent, single‑quote, trailing‑comma all.
- Enforce `no-var`, `prefer-const`, `no-console` (except in dev scripts).

---

## Cursor / Copilot Rules (if present)

- **.cursor/rules/**: The repository includes `nexus‑prime.mdc` which defines the build, lint, and test commands above and enforces:
  - Functions < 50 lines, files < 500 lines.
  - No `any` types unless justified.
  - Error handling on all async ops.
  - Strict commit co‑author trailer (`Co‑Authored‑By: nexus‑prime <33547839+sir-ad@users.noreply.github.com>`).
- **.github/copilot‑instructions.md**: not present; if added in future, incorporate its guidelines here.

---

## Git Commit Policy (re‑stated)

All AI‑generated commits must include the co‑author trailer:

```
Co-Authored-By: nexus‑prime <33547839+sir-ad@users.noreply.github.com>
```

Commit messages follow Conventional Commits (`type(scope): description`).

---

*End of AGENTS.md*

<!-- nexus-prime:codex-bootstrap:start -->
## Nexus Prime Bootstrap (managed)

> This block is managed by `nexus-prime setup codex` or automatic bootstrap.
> Keep your project-specific Codex guidance above or below it.

## Nexus Prime Managed Bootstrap

- REQUIRED session start: call `nexus_session_bootstrap(goal, files?)`, then `nexus_orchestrate(prompt=<raw user request>)`.
- `nexus_orchestrate` does NOT replace during-work or session-close lifecycle steps.
- Use `nexus_plan_execution` only when a plan-before-run is requested.
- Discover catalogs only when needed: `nexus_list_skills`, `nexus_list_workflows`, `nexus_list_hooks`, `nexus_list_automations`, `nexus_list_specialists`, `nexus_list_crews`.
- REQUIRED before reading 3+ files: call `nexus_optimize_tokens(goal, files)`.
- REQUIRED before file modification or destructive work: call `nexus_mindkit_check(action, filesToModify)`.
- REQUIRED before refactoring 3+ files: call `nexus_ghost_pass(goal, files)`.
- REQUIRED after significant findings and at session end: call `nexus_store_memory(content, priority, tags)`.
- REQUIRED before ending the session: call `nexus_session_dna(action="generate")`.
- Worker context lives in `.agent/runtime/context.json`; the compiled packet lives in `.agent/runtime/packet.json`.
<!-- nexus-prime:codex-bootstrap:end -->

