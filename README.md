# pi-zephyr-extensions

Plan / work / review / compound workflows for embedded firmware, in the style of
Everyday Compound Engineering but aimed at Zephyr RTOS kernel and architecture work.
One pi package, several sub-extensions.

Install: add the directory to `~/.pi/agent/settings.json`, either as
`"extensions": ["<...>/pi-zephyr-extensions"]` or `"packages": ["<...>/pi-zephyr-extensions"]`.
Both load the entries listed in `package.json` under `pi.extensions`. List each entry
explicitly, because globs are not expanded on the `extensions` path.

## Layout

```
package.json              pi.extensions: one entry per sub-extension
shared/
  git.ts                  git(), slugify(), repoSlug(), branchFeature()
  workflow.ts             registerWorkflow(): artifact store, feature tracking,
                          artifact path tool, /<x>feature command, system prompt,
                          skills/ + prompts/ discovery
extensions/
  zephyr-subagents/       `subagent` tool, registered once for the whole package
  zephyr-workflow/        Zephyr RTOS plan / work / review / compound workflow
  zephyr-limit-repeated-tool-calls/
                          nudges the model when it repeats an identical tool call
```

Each sub-extension documents itself in its own `README.md`.

## Adding a sub-extension

1. Create `extensions/zephyr-<name>/` (every sub-extension uses the `zephyr-` prefix)
   with `index.ts`, `README.md`, `skills/`, `prompts/` and optionally `agents/`, using
   `extensions/zephyr-workflow/` as the reference.
2. In `index.ts`, call `registerWorkflow()` with a unique `id`, `envPrefix`, `toolName` and
   `featureCommand`. Two sub-extensions must never share a tool or command name.
3. Give skills, prompts and agents unique names. Pick a command prefix that does not
   collide with others (for example `z*` for Zephyr).
4. Add `"./extensions/zephyr-<name>/index.ts"` to `pi.extensions` in `package.json`, then `/reload`.

A sub-extension without the workflow (a plain tool, for example) only needs an `index.ts`
that exports `default function (pi: ExtensionAPI)`. Its `agents/` directory is still picked
up by the subagent tool.
