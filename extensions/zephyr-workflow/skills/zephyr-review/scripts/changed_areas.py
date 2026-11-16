#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Group the files changed in <base>...HEAD by MAINTAINERS.yml area.

Usage: changed_areas.py [--repo DIR] [--base REF] [--max-groups N]

Prints JSON: {"base", "groups": [{"area", "labels", "meta", "files"}], "unowned": []}.
Each file goes to exactly one group: the non-meta area that owns the fewest tree
files (most specific); files owned only by meta areas (tests, docs, ...) go to
the meta area. Groups beyond --max-groups are merged into the largest remaining
group sharing a top-level directory, else into "Other".
"""
import argparse
import json
import os
import subprocess
import sys


def git(repo, *a):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True,
                          check=False).stdout


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", default=".")
    p.add_argument("--base")
    p.add_argument("--max-groups", type=int, default=6)
    args = p.parse_args()

    repo = git(args.repo, "rev-parse", "--show-toplevel").strip()
    base = args.base
    if not base:
        for cand in ("upstream/main", "zephyr/main", "origin/main"):
            if git(repo, "rev-parse", "--verify", "-q", cand).strip():
                base = cand
                break
    if not base:
        sys.exit("no base ref found; pass --base")

    sys.path.insert(0, os.path.join(repo, "scripts"))
    import get_maintainer as gm

    m = gm.Maintainers(os.path.join(repo, "MAINTAINERS.yml"))
    os.chdir(repo)
    files = git(repo, "diff", "--name-only", f"{base}...HEAD").split()

    tree = git(repo, "ls-files").split()
    size_cache = {}

    def area_size(area):
        if area.name not in size_cache:
            size_cache[area.name] = sum(1 for f in tree if area._contains(f))
        return size_cache[area.name]

    groups = {}
    unowned = []
    for f in files:
        areas = m.path2areas(f)
        if not areas:
            unowned.append(f)
            continue
        pool = [a for a in areas if not a.meta] or areas
        a = min(pool, key=area_size)
        g = groups.setdefault(a.name, {"area": a.name, "labels": a.labels,
                                       "meta": bool(a.meta), "files": []})
        g["files"].append(f)

    out = sorted(groups.values(), key=lambda g: -len(g["files"]))
    if len(out) > args.max_groups:
        keep, rest = out[:args.max_groups - 1], out[args.max_groups - 1:]
        other = {"area": "Other", "labels": [], "meta": False,
                 "files": [f for g in rest for f in g["files"]],
                 "merged_areas": [g["area"] for g in rest]}
        out = keep + [other]
    json.dump({"base": base, "groups": out, "unowned": unowned}, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
