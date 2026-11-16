# zephyr-workflow

Plan / work / review / compound workflow for Zephyr RTOS kernel and architecture work.

Commands: `/zbrainstorm`, `/zplan`, `/zwork`, `/zreview`, `/zcompound`, `/zfeature`.

```
index.ts                  registerWorkflow({ id: "zephyr-agent", ... }) from shared/workflow.ts
skills/                   zephyr-{brainstorm,plan,work,review,compound}
  zephyr-review/
    focus.md              review hints per area kind
    scripts/changed_areas.py
prompts/                  /z* command templates
agents/
  zephyr-area-reviewer.md generic per-area reviewer, used by the subagent tool
```

## Artifacts

Artifacts are stored outside the repo in `~/.pi/agent/zephyr-agent/<repo>/{solutions,work/<feature>}`
(override the root with `ZEPHYR_AGENT_HOME`). The `zephyr_agent_artifact_path` tool resolves
paths. The active feature is the one saved in the session, else the current branch name
(not on `main`, `master` or `vX.Y-branch`). Set it with `/zfeature <slug>`.

Env vars: `ZEPHYR_AGENT_PROJECT`, `ZEPHYR_AGENT_ARTIFACTS`, `ZEPHYR_AGENT_FEATURE_DIR`; set
`ZEPHYR_AGENT_FEATURE_DIR_OVERRIDE` to force a feature.

## Review

`/zreview` groups the changed files by MAINTAINERS.yml area with
`skills/zephyr-review/scripts/changed_areas.py` and dispatches `zephyr-area-reviewer` once per
area through the `subagent` tool (from `zephyr-subagents`).
