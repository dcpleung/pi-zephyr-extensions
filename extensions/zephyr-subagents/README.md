# zephyr-subagents

Provides the `subagent` tool (single, parallel and chain modes), adapted from pi's
`examples/extensions/subagent`. It is registered once for the whole package, so other
sub-extensions must not register it themselves.

Changes from the upstream example:

- Agents are loaded from every sibling `extensions/*/agents/` directory, then from
  `~/.pi/agent/agents/`. A user agent with the same name overrides a bundled one.
- Child usage is reported through `tool_result`, so it counts toward the footer,
  `/session` and RPC totals.

Project-local agents in `.pi/agents/` are used only with `agentScope: "both"` or
`"project"`, and need confirmation before they run.
