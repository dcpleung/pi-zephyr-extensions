---
description: "Process upstream review comments on your own PR: evaluate, fix, and draft replies"
argument-hint: "[pr-number] [notes]"
---
Load the zephyr-pr-babysit skill and babysit the user's upstream PR. This is only for a feature that has been through brainstorm, plan, work and review: the skill checks that first and refuses otherwise. The first word below is the PR number (optional once it is stored in state.json, required the first time); the current directory is the Zephyr tree; anything after the number is the user's notes for this round: $@
