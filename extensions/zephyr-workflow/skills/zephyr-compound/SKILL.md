---
name: zephyr-compound
description: Capture lessons from a solved Zephyr problem into the shared solutions store so future plans and reviews benefit. Use after fixing a non-trivial issue or finishing a feature.
---
# Zephyr compound

For each non-obvious problem solved, write a note via `zephyr_agent_artifact_path(kind="solution", name=<slug>)`:

```
---
category: kernel|driver|dt|kconfig|build|timing|memory|test|process
date: YYYY-MM-DD
boards: [...]
---
Symptom / Root cause / Fix / How to detect early / Related files
```

Keep it terse and factual. Check for an existing note first and update it rather than duplicating. When the feature is merged or abandoned, set `state.json` status to `done`. Offer to promote notes worth upstreaming into `doc/` as a separate change.
