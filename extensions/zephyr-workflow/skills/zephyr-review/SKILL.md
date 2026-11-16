---
name: zephyr-review
description: Review Zephyr RTOS changes through embedded-specific lenses (concurrency, memory, devicetree/Kconfig, API, style/compliance, security, portability). Use before submitting a PR.
---
# Zephyr review

Preferred: dispatch one area reviewer per MAINTAINERS.yml area, using the `subagent` tool in `tasks` mode.

1. Group the changed files by area (run from the repo root; `--base` is optional and defaults to `upstream/main`, `zephyr/main`, then `origin/main`):
   `python3 <skill-dir>/scripts/changed_areas.py [--base <ref>]`, where `<skill-dir>` is this skill's directory (the one containing this SKILL.md).
   Each file goes to exactly one area: the most specific non-meta area, else the meta area (tests, docs, ...). More than 6 groups are merged into "Other".
2. For each group, add a task for agent `zephyr-area-reviewer` containing: the area name, the base ref, the file list, the user's focus, and the matching focus hints from `focus.md` in this skill's directory (read it). Mention that the reviewer owns only those files.
3. Files in `unowned`, and the "Other" group if it is small, are reviewed by you.
4. Merge, deduplicate and prioritize findings. "Cross-area" notes mean another area may need a look: check it yourself or add a reviewer. Verify disputed or high-severity claims against the tree before reporting them.

Subagents are read-only. Cross-cutting checks below (commit message, compliance, hardware risk, security, portability) are yours. If the subagent tool is unavailable, review each area yourself in turn.

Collect the diff (`git diff upstream/main...HEAD` or `origin/main`). Check `solutions/` for known pitfalls. Review through each lens and record findings by severity (blocker / should-fix / nit) with file:line.

- **Kernel/concurrency**: ISR vs thread context, blocking calls in ISRs, `K_FOREVER`, spinlock/mutex/sem misuse, priorities, SMP races.
- **Memory**: stack sizes, heap use, alignment, cache/DMA buffers, footprint growth.
- **DT/Kconfig**: bindings, `DT_INST_*` usage, `select` vs `depends on`, undefined symbols, vendor prefixes.
- **Driver/API**: device model, init priority, PM, Doxygen `@retval`, stable API `@version` bump, migration guide/release notes.
- **Style/MISRA**: AGENTS.md "Code rules", essentially-Boolean conditions, types, scope of objects.
- **Security**: syscall verification, bounds checks, userspace boundaries.
- **Portability/tests**: multi-arch coverage, twister scenarios, `tests.yaml` metadata.
- **Hardware risk**: list everything unverified on real hardware.

Run `./scripts/ci/check_compliance.py -c <base>..HEAD` and checkpatch via `git format-patch -1 --stdout <sha> | ./scripts/checkpatch.pl -`.
Write the merged, prioritized findings to `zephyr_agent_artifact_path(kind="review")`; set `state.json` status `in-review`.
