# Multi-agent tool research

Checked September 9, 2026 against current first-party pages. Recommendation: pilot Agent Orchestrator (AO), with a small repository-specific integration policy. Findings describe documented capabilities, not a tested installation.

## Agent Orchestrator: strongest fit

The former `ComposioHQ/agent-orchestrator` URL now redirects to `Untrivial-ai/agent-orchestrator`. The current project is Apache-2.0 licensed. Its persistent project orchestrator plans and delegates, while each Git-backed worker gets a branch and worktree. Claude Code and Codex are both supported. This directly matches the requested central coordinator and mixed coding workers. [Current repository](https://github.com/Untrivial-ai/agent-orchestrator)

Worker and orchestrator harnesses are independently configurable; individual workers can override the project agent. The CLI exposes session spawning, messaging, restoration, cleanup, PR merging, and review execution. Its documented session kinds are `worker` and `orchestrator`; a dedicated `integrator` is not a built-in kind. [CLI reference](https://useao.dev/docs/cli/)

Set the project `defaultBranch` explicitly to `integration` to base new worktrees there. Standing worker rules, orchestrator rules, reviewers, environment variables, and repeatable post-creation setup are supported. Configuration is stored in the daemon database, not a repository YAML file. [Project configuration](https://useao.dev/docs/configuration/projects/)

**Integration gap:** designate a normal worker as the integration agent through its task instructions. Give it exclusive responsibility for ordering PRs into `integration`, validating the combined result, and handling coordination failures. Explicit PR base selection, exclusive merge authority, combined-result CI, and promotion to `main` remain repository policy/configuration to establish and validate. The documented base-worktree setting alone does not prove all generated PRs will target `integration`.

AO automatically sends CI failures, unresolved review feedback, and merge conflicts to the owning session. Merge-ready changes produce notifications. It does **not** currently support configurable automatic merge, per-reaction retry budgets, or the older `reactions:` YAML. Explicit merge actions are available. [Lifecycle automation](https://useao.dev/docs/configuration/lifecycle-automation/)

Native Windows desktop, structured Chat, and ConPTY terminal sessions are documented; tmux is unnecessary on Windows. This is a local desktop system, not a hosted multi-user orchestrator. [Platforms](https://useao.dev/docs/platforms/)

Install the desktop release for a pilot. AO uses installed agent CLIs and their sign-ins plus Git and authenticated `gh`; it does not bundle the coding providers. The npm package is frozen at 0.10.0 and is a legacy launcher, so older npm/YAML tutorials should not guide a fresh setup. [Installation](https://useao.dev/docs/installation/)

One limitation matters for durable task tracking: current repository status says GitHub PR observation works, but agent-lifecycle-to-issue mirroring is not a runtime feature. Do not assume GitHub Issues automatically stay synchronized with workers. [Implementation status](https://raw.githubusercontent.com/Untrivial-ai/agent-orchestrator/main/docs/STATUS.md)

## Vibe Kanban: capable, but weaker new-project choice

Vibe Kanban is Apache-2.0 licensed and supports Claude Code, Codex, parallel workspaces, and agent review. [Repository](https://github.com/BloopAI/vibe-kanban)

Its local MCP server exposes workspace creation with an executor and repository branch, session prompting, execution inspection, and session listing. An external coding agent can use those primitives to coordinate workers; the specific integration policy would still need to be supplied. [MCP server](https://www.vibekanban.com/docs/integrations/vibe-kanban-mcp-server)

GitHub PR creation uses authenticated `gh`, and the PR dialog allows a base branch. Windows/Linux installation guidance exists for this integration. [GitHub integration](https://www.vibekanban.com/docs/integrations/github-integration)

However, Bloop announced its shutdown on April 10, 2026. The project continues as community-maintained open source; the announcement says remote services would end after 30 days while local workspaces continue. This makes it a less attractive foundation for a new important workflow, particularly if expecting maintained hosted issue tracking. [Shutdown announcement](https://www.vibekanban.com/blog/shutdown)

## Pilot acceptance criteria

Run one coordinator, one Claude worker, one Codex worker, and one serialized integration worker. Confirm task handoff and recovery, separate worktrees, explicit PR bases, failure feedback, and combined-result checks. Validate the exact installed AO version before relying on unattended integration. Start with rules and existing CLI/CI configuration; add custom code only for an observed missing enforcement mechanism.
