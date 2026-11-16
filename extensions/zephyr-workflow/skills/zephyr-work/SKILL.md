---
name: zephyr-work
description: Execute a Zephyr plan incrementally with build and twister verification. Use to implement the active feature plan.
---
# Zephyr work

1. Read the plan (`zephyr_agent_artifact_path` kind `plan`). Update `state.json` status to `in-progress`.
2. In a git worktree, export `ZEPHYR_BASE=<worktree>` for west/twister. Record the worktree and branch in `state.json`.
3. Implement one checklist item at a time. After each: build (`west build -b <board>`) or `west twister -p native_sim -T <dir>`, then tick the item in the plan.
4. Follow AGENTS.md rules: style, explicit comparisons, fixed-width types, Doxygen, Kconfig/DT conventions.
5. Commits: stage explicit paths only; `area: subarea: summary`; add exactly one `Assisted-by:` trailer; never add `Signed-off-by` or `Co-authored-by`.
6. Be explicit about what was not built, not run, or not run on hardware.
7. Never run `west flash`/`west debug` without asking the user.
