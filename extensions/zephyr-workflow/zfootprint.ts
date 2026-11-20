/**
 * Zephyr footprint diff (/zfootprint) - manual only
 *
 * Builds one application for one board twice, once at the point where HEAD forked from
 * the upstream base (in a temporary git worktree) and once in your tree as it is now,
 * then compares the RAM and ROM reports (ram_report / rom_report) with
 * scripts/footprint/fpdiff.py. Nothing runs unless you type the command: no tool, skill
 * or prompt invokes it.
 *
 *   /zfootprint [board] [app] [--base <ref>] [-- extra west build args]
 *
 * board and app default to the settings below; app defaults to tests/benchmarks/footprints.
 * Your tree is built as-is, including uncommitted changes. Builds go to a temporary
 * directory, so your own build directories are untouched.
 *
 * Settings (settings.json, key "zfootprint"; tree/python/base fall back to "zcheckCompliance"):
 *   board   Default board
 *   app     Default application, relative to the tree
 *   args    Extra `west build` arguments (array), e.g. ["--", "-DCONFIG_FOO=y"]
 *   python  Python with west and the footprint tools (anytree, colorama) installed
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CommonSettings, readSettings, resolveZephyrEnv, runStreaming } from "./zephyr-env.ts";

const MAX_DIFF_LINES = 60;
const BUILD_TIMEOUT = 30 * 60_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface Settings extends CommonSettings {
	board?: string;
	app?: string;
	args?: string[];
}

/* Total size in bytes from a ram.json / rom.json report. */
function totalSize(file: string): number | undefined {
	try {
		const size = JSON.parse(readFileSync(file, "utf8")).size;
		return typeof size === "number" ? size : undefined;
	} catch {
		return undefined;
	}
}

const fmtDelta = (before: number | undefined, after: number | undefined) => {
	if (before === undefined || after === undefined) return "n/a";
	const d = after - before;
	const pct = before ? ` (${d >= 0 ? "+" : ""}${((d / before) * 100).toFixed(2)}%)` : "";
	return `${before} -> ${after} B, ${d >= 0 ? "+" : ""}${d} B${pct}`;
};

export function registerZfootprint(pi: ExtensionAPI) {
	pi.registerCommand("zfootprint", {
		description: "Compare RAM/ROM footprint of an app between the upstream fork point and your tree (manual)",
		handler: async (rawArgs, ctx) => {
			const cfg = readSettings<Settings>(pi, "zfootprint");
			const [head, ...rest] = rawArgs.split(/\s+--\s+|\s+--$/);
			const tokens = head.trim().split(/\s+/).filter(Boolean);
			let baseArg: string | undefined;
			const positional: string[] = [];
			for (let i = 0; i < tokens.length; i++) {
				if (tokens[i] === "--base") baseArg = tokens[++i];
				else positional.push(tokens[i]);
			}
			const board = positional[0] ?? cfg.board;
			const app = positional[1] ?? cfg.app ?? "tests/benchmarks/footprints";
			if (!board) {
				ctx.ui.notify("Usage: /zfootprint <board> [app] [--base <ref>] [-- west build args]", "error");
				return;
			}
			const extra = [...(cfg.args ?? []), ...rest.join(" ").trim().split(/\s+/).filter(Boolean)];

			const env = await resolveZephyrEnv(pi, ctx.cwd, cfg, baseArg);
			if (typeof env === "string") {
				ctx.ui.notify(env, "error");
				return;
			}
			const { tree, python, fork, label } = env;
			const westTop = await pi.exec(python, ["-m", "west", "topdir"], { cwd: tree });
			if (westTop.code !== 0) {
				ctx.ui.notify(`west not usable with ${python} (set zfootprint.python):\n${westTop.stderr.trim()}`, "error");
				return;
			}
			const topdir = westTop.stdout.trim();
			/* The base worktree must sit inside the west workspace so west finds the manifest and modules. */
			const wtParent = existsSync(join(topdir, "worktrees")) ? join(topdir, "worktrees") : topdir;
			const wt = join(wtParent, `zfootprint-base-${process.pid}-${Date.now()}`);

			const tmp = mkdtempSync(join(tmpdir(), "zfootprint-"));
			const started = Date.now();
			let stage = "starting";
			let lastLine = "";
			const render = () => {
				const secs = Math.round((Date.now() - started) / 1000);
				const headLine = `zfootprint ${board} ${app}: ${stage}, ${secs}s`;
				ctx.ui.setWorkingMessage(headLine);
				ctx.ui.setWidget("zfootprint", [headLine, ...(lastLine ? [`  ${lastLine.slice(0, 160)}`] : [])]);
			};
			const onLine = (line: string) => {
				if (line.trim()) lastLine = line.trim();
			};
			const tick = setInterval(render, 1000);
			render();

			let worktreeAdded = false;
			let failure: string | undefined;
			const run = async (what: string, cmd: string, args: string[], cwd: string, zephyrBase: string) => {
				stage = what;
				lastLine = "";
				render();
				const res = await runStreaming(cmd, args, {
					cwd,
					signal: ctx.signal,
					timeout: BUILD_TIMEOUT,
					onLine,
					env: { ZEPHYR_BASE: zephyrBase },
				});
				if (res.code !== 0) {
					failure = `${what} failed (exit ${res.code}):\n${res.output.trim().split("\n").slice(-25).join("\n")}`;
				}
				return res.code === 0;
			};

			try {
				const add = await pi.exec("git", ["worktree", "add", "--detach", wt, fork], { cwd: tree });
				if (add.code !== 0) {
					ctx.ui.notify(`git worktree add failed:\n${add.stderr.trim()}`, "error");
					return;
				}
				worktreeAdded = true;

				const sides = [
					{ name: "base", dir: wt, build: join(tmp, "build-base") },
					{ name: "head", dir: tree, build: join(tmp, "build-head") },
				];
				for (const s of sides) {
					const west = (...a: string[]) => [python, ["-m", "west", ...a]] as const;
					const [cmd, args] = west("build", "-b", board, app, "-d", s.build, "-p", "always", ...extra);
					if (!(await run(`building ${s.name}`, cmd, [...args], s.dir, s.dir))) break;
					for (const target of ["ram_report", "rom_report"]) {
						const [c, a] = west("build", "-d", s.build, "-t", target);
						if (!(await run(`${target} (${s.name})`, c, [...a], s.dir, s.dir))) break;
					}
					if (failure) break;
				}
				if (failure) {
					ctx.ui.notify(`zfootprint: ${failure}`, "error");
					return;
				}

				stage = "diffing";
				render();
				const lines = [`**zfootprint ${board} ${app}** against ${label}`, ""];
				for (const kind of ["ram", "rom"]) {
					const a = join(tmp, "build-base", `${kind}.json`);
					const b = join(tmp, "build-head", `${kind}.json`);
					lines.push(`### ${kind.toUpperCase()}: ${fmtDelta(totalSize(a), totalSize(b))}`);
					if (!existsSync(a) || !existsSync(b)) {
						lines.push(`(no ${kind}.json produced)`, "");
						continue;
					}
					const diff = await pi.exec(python, [join(tree, "scripts/footprint/fpdiff.py"), a, b], { cwd: tree });
					const text = `${diff.stdout}${diff.code !== 0 ? diff.stderr : ""}`.replace(ANSI_RE, "").trim();
					const diffLines = text ? text.split("\n") : ["(no symbol differences)"];
					lines.push("```", ...diffLines.slice(0, MAX_DIFF_LINES));
					if (diffLines.length > MAX_DIFF_LINES) lines.push(`... (${diffLines.length - MAX_DIFF_LINES} more lines)`);
					lines.push("```", "");
				}
				pi.sendMessage({ customType: "zfootprint", content: lines.join("\n"), display: true, details: { board, app, fork } });
				ctx.ui.notify("zfootprint: done", "info");
			} finally {
				clearInterval(tick);
				ctx.ui.setWorkingMessage();
				ctx.ui.setWidget("zfootprint", undefined);
				if (worktreeAdded) await pi.exec("git", ["worktree", "remove", "--force", wt], { cwd: tree });
				rmSync(tmp, { recursive: true, force: true });
			}
		},
	});
}
