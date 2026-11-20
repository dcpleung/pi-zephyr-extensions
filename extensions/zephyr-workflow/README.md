# zephyr-workflow

Plan / work / review / compound workflow for Zephyr RTOS kernel and architecture work.

Commands: `/zbrainstorm`, `/zplan`, `/zwork`, `/zreview`, `/zcompound`, `/zfeature`, `/zcheck-compliance`, `/zfootprint`, `/ztwister`.

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

## Compliance check

`/zcheck-compliance [base-ref] [-- extra args]` runs `scripts/ci/check_compliance.py` (gitlint, checkpatch,
whitespace, Kconfig, devicetree, ...) on the local commits since HEAD forked from the base (`git merge-base <base> HEAD..HEAD`) and shows only the failing checks. The tree
is the current directory if it is a Zephyr tree, else `~/zephyr/rtos/zephyr`. The base is the upstream ref and defaults to
the first of `zephyr/main`, `upstream/main`, `origin/main`. Optional `zcheckCompliance` settings (the old `zcheck` key is still read) in
`settings.json`: `tree`, `python` (a Python with `scripts/requirements-compliance.txt`
installed), `base`, `args`. Only committed changes are checked.

## Footprint diff

`/zfootprint [board] [app] [--base <ref>] [-- extra west build args]` builds the app for the board
twice, at the point where HEAD forked from the base (in a temporary git worktree inside the west
workspace) and in your tree as it is now, then compares `ram_report` and `rom_report` with
`scripts/footprint/fpdiff.py`. It is manual only: no tool, skill or prompt calls it. The app
defaults to `tests/benchmarks/footprints`. Builds use a temporary directory, and the worktree is removed
afterwards. Settings under `zfootprint` in `settings.json`: `board`, `app`, `args`, and `python`
(needs west plus the footprint tools); `tree`, `python` and `base` fall back to the `zcheckCompliance` ones.

## Twister digest

`/ztwister [test paths...] [-- extra twister args]` runs twister (default scope `tests/kernel` on
`native_sim`) and shows only what needs attention: failures grouped by scenario and reason across
platforms, each with its reason, log path and a rerun command, plus counts and the top skip
reasons. Giving your own platform selection after `--` replaces the default platform. Manual only.
Output goes to a temporary directory that the next run replaces. Settings under `ztwister`:
`scope`, `platforms`, `args`; `tree`, `python`, `base` fall back to the `zcheckCompliance` ones.
