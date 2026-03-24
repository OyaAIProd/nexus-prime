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

## Git Commit Policy

All commits made by AI agents (Claude, Copilot, or any automated tool) MUST include the following co-author trailer:

```
Co-Authored-By: nexus-prime <33547839+sir-ad@users.noreply.github.com>
```

- Do NOT use any other identity (e.g. `claude-flow`, `ruv`, etc.) as co-author.
- The only acceptable co-author for automated/AI commits is `nexus-prime`.
- This applies to all branches, PRs, and release commits.

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

<!-- nexus-prime:synapse:start -->
## Synapse Operative Protocol
> Only active when env SYNAPSE_OPERATIVE_ID is set.

IF SYNAPSE_OPERATIVE_ID is set:
1. `nexus_synapse_sortie_start(operativeId)` first in every session
2. `nexus_synapse_echo(missionTitle)` before work
3. `nexus_synapse_cost_report(...)` after significant LLM usage
4. `nexus_synapse_mission_progress(...)` after meaningful findings
5. `nexus_synapse_request_approval(...)` before delete/overwrite/reset and wait
6. `nexus_synapse_sortie_end(...)` last in every session
7. Check `nexus_architects_relay_inbox(...)` at session start
8. Do not call `nexus_session_bootstrap` directly inside a Synapse sortie
<!-- nexus-prime:synapse:end -->

<!-- nexus-prime:architects:start -->
## Architects Operative Protocol
> Only active when env ARCHITECTS_OPERATIVE_ID is set.

IF ARCHITECTS_OPERATIVE_ID is set:
1. `nexus_architects_worklist_get(worklistId)` at session start
2. `nexus_architects_workitem_claim(workItemId, operativeId)` before any work
3. Work only on the branch assigned to that WorkItem
4. `nexus_architects_workitem_complete(...)` when done or blocked
5. Never push directly to main
6. Use `nexus_architects_relay_send(...)` for operative-to-operative messages
7. Escalate 2+ sortie blockers to ward via relay instead of waiting silently
<!-- nexus-prime:architects:end -->




































































































