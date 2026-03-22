# v5.0: Build Synapse + Architects as engine-backed runtime modules

## Problem Statement

Nexus Prime already has the engine substrate for orchestration, eventing, work ledgers, workflow resolution, hook lifecycle, worktree health, session DNA, and memory/context handling. It does not yet ship runtime modules that turn those primitives into durable Operative management and coordinated work execution.

The repo also already ships a concise managed-bootstrap AGENTS flow. The v5 rollout must preserve that lightweight instruction model instead of replacing it with a long protocol file, and it must extend the established CLI without breaking existing setup semantics.

## Non-goals

- No broad refactor of existing engine files beyond additive event typing in `src/engines/event-bus.ts`.
- No breaking change to existing `setup all` behavior.
- No replacement of the current dashboard topology shell; only additive panels, flags, and routes.
- No long-form `AGENTS.md` or `CLAUDE.md` rewrite.

## Command-Surface Decision

- Keep existing client-install setup commands untouched.
- Add runtime setup as:
  - `nexus-prime setup runtime synapse`
  - `nexus-prime setup runtime architects`
  - `nexus-prime setup runtime all`
- Make runtime setup idempotent: safe schema re-runs, marker-safe doc injection, append-only `.env.example`, and no overwrite of user custom content.

## Adapter-Strategy Decision

- Synapse uses current task planning, orchestration, memory, and session context through adapters.
- Architects uses current workflow, work ledger, hook lifecycle, relay, and worktree health through adapters.
- Any mismatch between PRD terminology and real engine methods is resolved inside module-local services and provider wrappers, not by changing `src/engines/*`.

## Phased Checklist

- Foundation
  - Create `src/synapse/` and `src/architects/` entrypoints, config, types, schema, adapters, and bootstrap files.
  - Add additive event typings in `src/engines/event-bus.ts`.
  - Add `src/cli-setup.ts` and register `setup runtime ...`.
- Synapse
  - Implement Operatives, Strike Teams, Missions, Sorties, Field Reports, approvals, budgets, Echo, compaction stand-down, watchdog patrol, scheduler, and ledger restore/export.
  - Register the 12 Synapse MCP tools.
  - Add focused tests under `src/synapse/__tests__/`.
- Architects
  - Implement Blueprints, Worklists, WorkItems, Construction Locks, Relay, Sentinel, Ward, Convergence Queue, and Dispatch Governor.
  - Register the 10 Architects MCP tools.
  - Add focused tests under `src/architects/__tests__/`.
- Integration
  - Wire both modules into runtime start/stop with shared repo root, event bus, orchestrator, and memory/session services.
  - Add `/api/synapse/*` and `/api/architects/*` routes plus additive dashboard views and capability flags.
  - Update `.env.example`, `.gitignore`, `AGENTS.md`, and `Claude.md` via managed setup blocks.
- QA
  - Run `npm run build`, `npm test`, targeted module suites, and runtime setup idempotency checks.
  - Smoke flow: mandate deploy, one sortie, one blocked lock, one convergence run.

## Acceptance Criteria

- Both modules can be disabled independently at startup without breaking the base runtime.
- Runtime setup is idempotent and does not alter existing client-install behavior.
- `AGENTS.md` and `Claude.md` injection is marker-safe and remains compact.
- One mandate can deploy a Strike Team, run at least one sortie, persist a Field Report, recover from ledger, block on a contested WorkItem lock, and complete one convergence run.
- Dashboard health stays green with the new capability flags and route groups.

## Open Risks

- Real engine method signatures may drift from the assumed adapter shapes.
- Dashboard integration may drift if topology layout code is more tightly coupled than expected.
- MCP registration may surface naming collisions or env-scoping issues.
- Relay and worktree-health polling costs must stay low enough not to degrade normal runtime behavior.
