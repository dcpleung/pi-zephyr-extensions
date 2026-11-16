---
name: zephyr-brainstorm
description: Clarify requirements for a Zephyr RTOS feature, driver, or fix before planning. Use at the start of new work.
---
# Zephyr brainstorm

The idea comes from the command argument. If it is missing, ask the user for it first; do not infer one from the branch name.

1. The active feature is the saved one, else the current branch name (unless main). If none is set, ask the user for a slug and pass it as the `feature` parameter of `zephyr_agent_artifact_path`.
2. Search `solutions/` (call `zephyr_agent_artifact_path` with kind `solution` to find the dir) for related past learnings.
3. Explore the tree: existing drivers, samples, bindings, `git log --oneline -20 -- <path>`, `MAINTAINERS.yml` areas.
4. Ask focused questions (use ask_user, one decision at a time): target boards/SoCs, RAM/flash budget, latency/power constraints, API stability impact, upstream vs. out-of-tree, test strategy (native_sim, qemu, hardware).
5. Write the result to the path from `zephyr_agent_artifact_path(kind="brainstorm")`: problem, constraints, options with tradeoffs, chosen direction, open questions.

Never write artifacts into the repo.
