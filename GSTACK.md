# GStack Integration for Nexus Prime

**GStack** is a workspace coordination and deployment tool globally installed at `~/gstack`. This document guides teammates on using GStack skills within the nexus-prime project.

## Quick Start

### Installation
GStack is installed globally and available to all teammates. No per-project installation required, but optional:

```bash
# Optional: Add gstack to project dependencies
bun install gstack --save-dev
```

### Configuration
- Project gstack config: `.gstackrc`
- CLAUDE.md includes GStack section with all available skills

## Available Skills

### Web Browsing & Navigation
- **`/browse`** — Web browsing, navigation, screenshot capture
  - Use this instead of `mcp__Claude_in_Chrome__*` tools
  - Replaces all Chrome/Playwright-based web interaction

### Planning & Reviews
- **`/plan-ceo-review`** — CEO-level review planning
- **`/plan-eng-review`** — Engineering review & feedback planning
- **`/plan-design-review`** — Design review coordination
- **`/design-consultation`** — Design consultation & feedback

### Development Workflows
- **`/review`** — Code/content review (integrates with Git)
- **`/ship`** — Prepare & execute deployments
- **`/land-and-deploy`** — Landing page & feature deployment
- **`/canary`** — Canary deployment testing & rollout

### Testing & QA
- **`/qa`** — Full QA & testing workflows
- **`/qa-only`** — QA-specific testing
- **`/benchmark`** — Performance benchmarking

### Investigation & Retrospectives
- **`/investigate`** — Debugging & root cause analysis
- **`/retro`** — Sprint retrospectives & team reviews

### Documentation & Knowledge
- **`/document-release`** — Release notes & documentation
- **`/codex`** — Code knowledge base & patterns
- **`/cso`** — Chief Security Officer mode (security reviews)

### Infrastructure & Safety
- **`/setup-browser-cookies`** — Browser environment setup
- **`/setup-deploy`** — Deployment environment setup
- **`/guard`** — Safety guardrails & compliance checks
- **`/freeze`** / **`/unfreeze`** — Feature freeze management
- **`/office-hours`** — Async office hours scheduling
- **`/gstack-upgrade`** — GStack version management

## Using GStack in Your Session

### For Web Browsing
Always prefer `/browse` over MCP Chrome tools:

```
❌ Use MCP Chrome tools
✅ Use /browse skill
```

### For Code Reviews
When reviewing teammates' code:
```bash
/review <pr-number>  # GStack will analyze PR & provide feedback
```

### For Deployments
When shipping features:
```bash
/ship <feature-name>        # Prepare & deploy
/canary <feature-name>      # Test in canary environment
/land-and-deploy <feature>  # Land on main + deploy
```

### For Planning
Before running complex work:
```bash
/plan-eng-review <scope>    # Plan engineering review
/autoplan <task>            # Automatic planning & breakdown
```

## Conflict Resolution

If you see conflicts between GStack skills and nexus-prime tools:
- **Web browsing**: Always use `/browse` (gstack)
- **Deployment**: Always use `/ship` or `/land-and-deploy` (gstack)
- **Code review**: Can use either `/review` (gstack) or inline Claude review
- **Planning**: Can use either `/plan-*` (gstack) or `nexus_orchestrate` (nexus-prime)

GStack is a **workspace layer** that coordinates with nexus-prime's **execution layer**.

## Troubleshooting

### GStack not found
```bash
# Check global installation
ls -la ~/gstack

# Reinstall if needed
git clone https://github.com/garrytan/gstack.git ~/.gstack
cd ~/.gstack && ./setup
```

### Skills not loading
```bash
# Check codex skills directory
ls -la ~/.codex/skills/

# Update GStack
/gstack-upgrade
```

### Browser skill not working
```bash
# Ensure /browse skill is available
# GStack should auto-provide it
# If missing, reinstall gstack and run setup
```

## Integration with Nexus Prime

- **Nexus Prime** (this project) handles: orchestration, memory, runtime management, token optimization
- **GStack** handles: web browsing, deployment, planning, team coordination
- **Synapse & Architects** (nexus-prime) handle: operative execution, blueprint management

They work **together** — GStack provides workspace tools, Nexus Prime provides execution context.

---

For more on GStack: `~/gstack/README.md` or `~/gstack/CLAUDE.md`
