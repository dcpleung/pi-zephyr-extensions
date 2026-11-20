/*
 * Shared helpers for the manually-invoked Zephyr commands (/zcheck-compliance, /zfootprint):
 * find the Zephyr tree, the upstream base ref and its merge-base with HEAD, the Python
 * to use, and run a command while streaming its output lines.
 *
 * Settings (settings.json): the command's own key ("zcheckCompliance", "zfootprint") overrides
 * "zcheckCompliance" (legacy name "zcheck" also read), so tree/python/base only need to be set once.
 *   tree    Zephyr tree, used when the cwd is not inside one (default ~/zephyr/rtos/zephyr)
 *   python  Python with the Zephyr tooling installed (default: a .venv at or above the
 *           tree, else python3)
 *   base    Upstream ref (default: first of zephyr/main, upstream/main, origin/main)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TREE = join(homedir(), "zephyr/rtos/zephyr");
const BASE_CANDIDATES = ["zephyr/main", "upstream/main", "origin/main"];
/* A file that identifies a Zephyr tree root. */
const TREE_MARKER = "scripts/ci/check_compliance.py";

export interface CommonSettings {
	tree?: string;
	python?: string;
	base?: string;
	[key: string]: unknown;
}

export function readSettings<T extends CommonSettings>(pi: ExtensionAPI, key: string): T {
	const all = (pi.getSettings() as Record<string, unknown> | undefined) ?? {};
	const pick = (k: string) => (all[k] && typeof all[k] === "object" ? (all[k] as CommonSettings) : {});
	return { ...pick("zcheck"), ...pick("zcheckCompliance"), ...pick(key) } as T;
}

export interface ZephyrEnv {
	tree: string;
	python: string;
	/* Upstream ref, the merge-base of that ref with HEAD, and a printable label. */
	base: string;
	fork: string;
	label: string;
}

/* Resolve the environment, or return an error message. */
export async function resolveZephyrEnv(
	pi: ExtensionAPI,
	cwd: string,
	cfg: CommonSettings,
	baseArg?: string,
): Promise<ZephyrEnv | string> {
	const inTree = async (dir: string) => {
		const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
		return top.code === 0 && existsSync(join(top.stdout.trim(), TREE_MARKER)) ? top.stdout.trim() : undefined;
	};
	const tree =
		(await inTree(cwd)) ?? (await inTree(resolve(cfg.tree?.replace(/^~/, homedir()) ?? DEFAULT_TREE)));
	if (!tree) return `No Zephyr tree found (cwd, then ${cfg.tree ?? DEFAULT_TREE}); set zcheckCompliance.tree`;

	let base = baseArg ?? cfg.base;
	if (!base) {
		for (const c of BASE_CANDIDATES) {
			if ((await pi.exec("git", ["rev-parse", "--verify", "-q", c], { cwd: tree })).code === 0) {
				base = c;
				break;
			}
		}
	}
	if (!base) return `No base ref found (tried ${BASE_CANDIDATES.join(", ")}); pass one explicitly`;

	const mb = await pi.exec("git", ["merge-base", base, "HEAD"], { cwd: tree });
	const fork = mb.stdout.trim();
	if (mb.code !== 0 || !fork) return `No common ancestor between ${base} and HEAD`;

	let python = cfg.python?.replace(/^~/, homedir());
	if (!python) {
		for (let d = tree, i = 0; i < 4; d = dirname(d), i++) {
			const p = join(d, ".venv/bin/python");
			if (existsSync(p)) {
				python = p;
				break;
			}
		}
	}
	return { tree, python: python ?? "python3", base, fork, label: `${base} (fork ${fork.slice(0, 12)})` };
}

export interface RunResult {
	code: number;
	output: string;
}

/*
 * Run a command, calling onLine for every output line as it arrives (pi.exec only returns
 * once the command is done). Output is kept for error reporting; the process is killed on
 * abort or timeout.
 */
export function runStreaming(
	cmd: string,
	args: string[],
	opts: {
		cwd: string;
		signal?: AbortSignal;
		timeout: number;
		onLine: (line: string) => void;
		env?: Record<string, string>;
	},
): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, PYTHONUNBUFFERED: "1", ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const pending = { out: "", err: "" };
		const feed = (key: "out" | "err") => (chunk: Buffer) => {
			const text = chunk.toString();
			output += text;
			pending[key] += text;
			const parts = pending[key].split(/\r?\n/);
			pending[key] = parts.pop() ?? "";
			for (const line of parts) opts.onLine(line);
		};
		child.stdout.on("data", feed("out"));
		child.stderr.on("data", feed("err"));
		const kill = () => child.kill("SIGTERM");
		const timer = setTimeout(kill, opts.timeout);
		opts.signal?.addEventListener("abort", kill, { once: true });
		const finish = (code: number, extra = "") => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", kill);
			resolvePromise({ code, output: output + extra });
		};
		child.on("error", (e) => finish(127, `${e.message}\n`));
		child.on("close", (code, sig) => finish(code ?? (sig ? 143 : 1)));
	});
}
