/*
 * Reusable plan / work / review / compound workflow plumbing.
 *
 * A sub-extension calls registerWorkflow() with its names and gets:
 * - an out-of-repo artifact store: <root>/<repo>/{solutions,work/<feature>}
 * - an active feature (session entry, else env override, else branch name)
 * - the <toolName> artifact path tool and the /<featureCommand> command
 * - a system prompt section describing the artifact locations
 * - its skills/ and prompts/ directories registered via resources_discover
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BranchFilter, branchFeature, defaultIgnoreBranch, git, repoSlug, slugify } from "./git.ts";

export const DEFAULT_KINDS = ["issue", "brainstorm", "plan", "review", "state", "solution"] as const;

export interface WorkflowConfig {
	/* Short display name, e.g. "Zephyr". */
	name: string;
	/* Artifact directory name under ~/.pi/agent and session entry prefix, e.g. "zephyr-agent". */
	id: string;
	/* Environment variable prefix, e.g. "ZEPHYR_AGENT" gives ZEPHYR_AGENT_HOME, ..._PROJECT, ... */
	envPrefix: string;
	/* Artifact path tool name, e.g. "zephyr_agent_artifact_path". */
	toolName: string;
	toolLabel: string;
	/* Feature command name without slash, e.g. "zfeature". */
	featureCommand: string;
	/* System prompt heading, e.g. "Zephyr agent artifacts". */
	title: string;
	/* What must not receive artifacts, e.g. "Zephyr repository". */
	repoNoun: string;
	/* Sub-extension directory holding skills/ and prompts/. */
	resourceDir: string;
	/* Artifact kinds; "solution" and "state" are special-cased. */
	kinds?: readonly string[];
	/* Branches that must not become a feature. */
	ignoreBranch?: BranchFilter;
}

/* What a sub-extension can do with the workflow's artifact store. */
export interface WorkflowHandle {
	/* Make <slug> the active feature (persisted in the session), creating its state.json; returns its directory. */
	useFeature(slug: string, cwd: string): { feature: string; dir: string };
	/* Resolve an artifact path for the active feature (see the artifact path tool). */
	pathFor(kind: string, name?: string): string;
}

export function registerWorkflow(pi: ExtensionAPI, cfg: WorkflowConfig): WorkflowHandle {
	const env = (k: string) => `${cfg.envPrefix}_${k}`;
	const ROOT = process.env[env("HOME")] ?? join(homedir(), ".pi", "agent", cfg.id);
	const STATE_ENTRY = `${cfg.id}-feature`;
	const KINDS = cfg.kinds ?? DEFAULT_KINDS;
	const ignoreBranch = cfg.ignoreBranch ?? defaultIgnoreBranch;
	const OVERRIDE = env("FEATURE_DIR_OVERRIDE");
	const FEATURE_DIR = env("FEATURE_DIR");

	let feature: string | undefined;
	let repo = "";

	const repoDir = () => join(ROOT, repo);
	const featureDir = () => (feature ? join(repoDir(), "work", feature) : undefined);
	const listFeatures = () => {
		const dir = join(repoDir(), "work");
		return existsSync(dir) ? readdirSync(dir).sort() : [];
	};

	function exportEnv() {
		/* Never overwrite explicit user overrides. */
		const set = (k: string, v: string | undefined) => {
			if (v !== undefined && !process.env[k]) process.env[k] = v;
		};
		set(env("PROJECT"), repo);
		set(env("ARTIFACTS"), repoDir());
		set(FEATURE_DIR, featureDir());
	}

	function setFeature(slug: string | undefined, persist: boolean) {
		feature = slug ? slugify(slug) : undefined;
		const dir = featureDir();
		if (dir) mkdirSync(dir, { recursive: true });
		/* Active feature changes must refresh a non-overridden env value. */
		if (!process.env[OVERRIDE]) {
			if (dir) process.env[FEATURE_DIR] = dir;
			else delete process.env[FEATURE_DIR];
		}
		if (persist) pi.appendEntry(STATE_ENTRY, { feature });
	}

	function resolveFeature(ctx: any) {
		let saved: string | undefined;
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type === "custom" && e.customType === STATE_ENTRY) saved = e.data?.feature;
		}
		const fromEnv = process.env[OVERRIDE] ? basename(process.env[OVERRIDE]!) : undefined;
		setFeature(fromEnv ?? saved ?? branchFeature(ctx.cwd, ignoreBranch), false);
	}

	/* Fall back to the branch name when no feature is set (not on main). */
	function ensureFeature(cwd: string) {
		if (feature) return;
		const b = branchFeature(cwd, ignoreBranch);
		if (b) setFeature(b, true);
	}

	function pathFor(kind: string, name?: string): string {
		if (kind === "solution") {
			const dir = join(repoDir(), "solutions");
			mkdirSync(dir, { recursive: true });
			return join(dir, `${slugify(name ?? "untitled")}.md`);
		}
		const dir = featureDir();
		if (!dir) throw new Error(`No active feature. Use /${cfg.featureCommand} <slug> first.`);
		mkdirSync(dir, { recursive: true });
		return join(dir, kind === "state" ? "state.json" : `${kind}.md`);
	}

	function useFeature(slug: string, cwd: string) {
		setFeature(slug, true);
		const sp = join(featureDir()!, "state.json");
		if (!existsSync(sp)) {
			writeFileSync(
				sp,
				JSON.stringify(
					{ feature, status: "brainstorm", branches: [git(cwd, "branch", "--show-current")].filter(Boolean), worktree: cwd },
					null,
					2,
				),
			);
		}
		return { feature: feature!, dir: featureDir()! };
	}

	pi.on("session_start", async (_e, ctx) => {
		repo = repoSlug(ctx.cwd, process.env[env("PROJECT")]);
		mkdirSync(join(repoDir(), "solutions"), { recursive: true });
		resolveFeature(ctx);
		exportEnv();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ensureFeature(ctx.cwd);
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## ${cfg.title}\n` +
				`Workflow artifacts (${KINDS.map((k) => (k === "solution" ? "solutions" : k)).join(", ")}) live OUTSIDE the ${cfg.repoNoun}. ` +
				`Never write them into the repo. Use the ${cfg.toolName} tool to resolve paths.\n` +
				`- Artifact root: ${repoDir()}\n` +
				`- Solutions (shared learnings): ${join(repoDir(), "solutions")}\n` +
				`- Active feature: ${feature ?? `(none; on main or detached HEAD: ask the user for a slug and pass it as the feature parameter of ${cfg.toolName})`}\n` +
				(featureDir() ? `- Feature directory: ${featureDir()}\n` : ""),
		};
	});

	pi.registerTool({
		name: cfg.toolName,
		label: cfg.toolLabel,
		description:
			"Resolve (and create the parent of) a workflow artifact path outside the repo. " +
			`kind: ${KINDS.filter((k) => k !== "solution").join("|")} for the active feature, solution (needs name) for shared learnings.`,
		parameters: Type.Object({
			kind: Type.String({ description: KINDS.join("|") }),
			name: Type.Optional(Type.String({ description: "Slug for solutions" })),
			feature: Type.Optional(Type.String({ description: "Set the active feature first (only when none is active)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.feature) setFeature(params.feature, true);
			else ensureFeature(ctx.cwd);
			if (!KINDS.includes(params.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
			const p = pathFor(params.kind, params.name);
			return { content: [{ type: "text", text: p }], details: { path: p } };
		},
	});

	pi.registerCommand(cfg.featureCommand, {
		description: `Show, list, or set the active ${cfg.name} feature: /${cfg.featureCommand} [slug|--list|--clear]`,
		handler: async (args, ctx) => {
			const a = args.trim();
			if (a === "--list") {
				ctx.ui.notify(listFeatures().join("\n") || "No features yet", "info");
			} else if (a === "--clear") {
				setFeature(undefined, true);
				ctx.ui.notify("Active feature cleared", "info");
			} else if (a) {
				useFeature(a, ctx.cwd);
				ctx.ui.notify(`Active feature: ${feature}\n${featureDir()}`, "info");
			} else {
				ctx.ui.notify(feature ? `${feature}\n${featureDir()}` : `No active feature (repo: ${repo})`, "info");
			}
		},
	});

	return { useFeature, pathFor };
}
