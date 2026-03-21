# AGENTS.md

IMPORTANT: Before starting ANY task, call `nexus_session_bootstrap` first.
After bootstrap, call `nexus_orchestrate` with the user's request.
Do NOT skip these steps. Do NOT manually explore files instead.

nexus_session_bootstrap(goal="<user request>", files=[optional candidate files])
nexus_orchestrate(prompt="<user request>")

During work, these lifecycle steps are REQUIRED:
- Before reading 3+ files: `nexus_optimize_tokens(goal="<what you're doing>", files=["src/foo.ts", ...])`
- Before any file modification or destructive operation: `nexus_mindkit_check(action="<what you're about to do>", filesToModify=["path/to/file"])`
- Before refactoring 3+ files: `nexus_ghost_pass(goal="<what you're changing>", files=["path/to/file"])`
- After significant findings: `nexus_store_memory(content="<specific learning>", priority=0.8, tags=["#bug", "#architecture", "#decision"])`

Session end is REQUIRED:
- `nexus_store_memory(content="Session YYYY-MM-DD: <what changed, why, and what remains>", priority=0.85, tags=["#session-summary"])`
- `nexus_session_dna(action="generate")`

`nexus_orchestrate` does NOT replace during-work or end-of-session lifecycle steps. Let Nexus choose the crew, specialists, skills, workflows, hooks, automations, worker count, and token strategy for orchestration itself.

Memory persists under ~/.nexus-prime/. Full operating protocol: docs/nexus-protocol.md

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

