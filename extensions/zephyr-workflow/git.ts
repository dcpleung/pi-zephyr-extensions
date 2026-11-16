/* Git and naming helpers shared by the workflow sub-extensions. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

export function git(cwd: string, ...args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

export const slugify = (s: string) =>
	s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* Repo slug: explicit override, then upstream/origin remote, then path hash. */
export function repoSlug(cwd: string, override?: string): string {
	if (override) return slugify(override);
	for (const remote of ["upstream", "origin"]) {
		const url = git(cwd, "remote", "get-url", remote);
		if (url) {
			const norm = url
				.replace(/^[a-z+]+:\/\//i, "")
				.replace(/^[^@/]+@/, "")
				.replace(/:/, "/")
				.replace(/\.git$/, "");
			const parts = norm.split("/").filter(Boolean);
			return slugify(parts.slice(-2).join("-"));
		}
	}
	const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const top = common ? dirname(common) : cwd;
	return `${slugify(basename(top))}-${createHash("sha1").update(top).digest("hex").slice(0, 6)}`;
}

export type BranchFilter = (branch: string) => boolean;

/* Branches that never map to a feature: main, master, and Zephyr-style vX.Y-branch. */
export const defaultIgnoreBranch: BranchFilter = (b) => ["main", "master"].includes(b) || /^v\d.*-branch$/.test(b);

export function branchFeature(cwd: string, ignore: BranchFilter = defaultIgnoreBranch): string | undefined {
	const b = git(cwd, "symbolic-ref", "--short", "-q", "HEAD");
	if (!b || ignore(b)) return undefined;
	return slugify(b.replace(/^(feature|fix|topic)\//, ""));
}
