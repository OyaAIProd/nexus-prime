# AGENTS.md

IMPORTANT: Before starting ANY task, call `nexus_session_bootstrap` first.
After bootstrap, call `nexus_orchestrate` with the user's request.
Do NOT skip these steps. Do NOT manually explore files instead.

nexus_session_bootstrap(goal="<user request>", files=[optional candidate files])
nexus_orchestrate(prompt="<user request>")

These two calls handle memory recovery, skill selection, token optimization, and execution planning automatically. Let Nexus choose the crew, specialists, skills, workflows, hooks, automations, worker count, and token strategy.

Store durable findings: nexus_store_memory(content="<specific learning>", priority=0.8, tags=["#bug", "#architecture", "#decision"])
End sessions: nexus_session_dna(action="generate")
Before reading 3+ files: nexus_optimize_tokens(goal="<what you're doing>", files=["src/foo.ts", ...])
Before risky mutations: nexus_mindkit_check(action="<what you're about to do>", filesToModify=["path/to/file"])

Memory persists under ~/.nexus-prime/. Full operating protocol: docs/nexus-protocol.md

<!-- nexus-prime:codex-bootstrap:start -->
## Nexus Prime Bootstrap (managed)

> This block is managed by `nexus-prime setup codex` or automatic bootstrap.
> Keep your project-specific Codex guidance above or below it.

## Nexus Prime Managed Bootstrap

- Start non-trivial work with `nexus_session_bootstrap(goal, files?)`.
- Then call `nexus_orchestrate(prompt=<raw user request>)` unless low-level control is explicitly required.
- Use `nexus_plan_execution` only when a plan-before-run is requested.
- Discover catalogs only when needed: `nexus_list_skills`, `nexus_list_workflows`, `nexus_list_hooks`, `nexus_list_automations`, `nexus_list_specialists`, `nexus_list_crews`.
- Before reading 3+ files, call `nexus_optimize_tokens(...)`.
- Before risky mutation, call `nexus_mindkit_check(...)`.
- Worker context lives in `.agent/runtime/context.json`; the compiled packet lives in `.agent/runtime/packet.json`.
<!-- nexus-prime:codex-bootstrap:end -->
