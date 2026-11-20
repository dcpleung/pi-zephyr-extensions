/**
 * Zephyr twister digest (/ztwister) - manual only
 *
 * Runs twister and reports only what needs attention: failures grouped by scenario and
 * reason across platforms, each with its reason, log path and a one-line rerun command.
 * Nothing runs unless you type the command: no tool, skill or prompt invokes it.
 *
 *   /ztwister [test paths...] [-- extra twister args]
 *
 * Defaults: tests/kernel on native_sim. Extra twister args go after "--"; giving your own
 * platform selection there (-p/--platform, -a/--all, -G, --device-testing) replaces the
 * default platform. The run writes to a temporary output directory that is replaced on the
 * next run, so log paths in the digest stay valid until then.
 *
 * Settings (settings.json, key "ztwister"; tree/python/base fall back to "zcheckCompliance"):
 *   scope      Default test paths relative to the tree (array, default ["tests/kernel"])
 *   platforms  Default platforms (array, default ["native_sim"])
 *   args       Extra twister arguments (array)
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CommonSettings, readSettings, resolveZephyrEnv, runStreaming } from "./zephyr-env.ts";

const TIMEOUT = 60 * 60_000;
const MAX_GROUPS = 25;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
/* Twister -v lines: "  12/173 native_sim/native/64   kernel.foo   PASSED (native 0.1s)" */
const PROGRESS_RE = /^\s*(\d+)\/(\d+)\s+(\S+)\s+(\S+)\s+(PASSED|FAILED|ERROR|SKIPPED|FILTERED|NOT RUN|BLOCKED)\b/;
const PLATFORM_ARGS = /^(-p|--platform(=.*)?|-a|--all|-G|--integration|--device-testing|--emulation-only)$/;
const LOG_HINT = /(assertion failed|assert.*fail|error:|fatal|overflowed|undefined reference|panic|timed? ?out)/i;

interface Settings extends CommonSettings {
	scope?: string[];
	platforms?: string[];
	args?: string[];
}

interface Testcase {
	identifier?: string;
	status?: string;
	reason?: string;
}
interface Suite {
	name: string;
	platform: string;
	path?: string;
	status?: string;
	reason?: string;
	log?: string;
	testcases?: Testcase[];
}

/* Find the build directory of one instance: <outdir>/<platform>/<toolchain>/[<path>/]<name>. */
function findBuildDir(outdir: string, s: Suite): string | undefined {
	const plat = join(outdir, s.platform.replace(/\//g, "_"));
	if (!existsSync(plat)) return undefined;
	for (const tc of readdirSync(plat)) {
		for (const cand of [join(plat, tc, s.name), join(plat, tc, s.path ?? "", s.name)]) {
			if (existsSync(cand)) return cand;
		}
	}
	return undefined;
}

function bestLog(dir: string | undefined): string | undefined {
	if (!dir) return undefined;
	for (const f of ["handler.log", "device.log", "build.log", "cmake.log"]) {
		const p = join(dir, f);
		if (existsSync(p)) return p;
	}
	return undefined;
}

const GENERIC = /^(failed?|error|build failure|cmake build failure|timeout|.*\bfailed)$/i;

function reasonOf(s: Suite): string {
	const failing = (s.testcases ?? []).filter((t) => t.status === "failed" || t.status === "error");
	let reason = failing.find((t) => t.reason)?.reason ?? s.reason ?? "";
	reason = reason.split("\n")[0].trim();
	if (!reason || GENERIC.test(reason)) {
		const hint = (s.log ?? "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => LOG_HINT.test(l));
		if (hint) reason = reason ? `${reason} - ${hint.slice(0, 200)}` : hint.slice(0, 200);
	}
	return reason || "(no reason recorded)";
}

export function registerZtwister(pi: ExtensionAPI) {
	pi.registerCommand("ztwister", {
		description: "Run twister (default: tests/kernel on native_sim) and show a digest of the failures (manual)",
		handler: async (rawArgs, ctx) => {
			const cfg = readSettings<Settings>(pi, "ztwister");
			const [head, ...rest] = rawArgs.split(/\s+--\s+|\s+--$/);
			const paths = head.trim().split(/\s+/).filter(Boolean);
			const extra = [...(cfg.args ?? []), ...rest.join(" ").trim().split(/\s+/).filter(Boolean)];

			const env = await resolveZephyrEnv(pi, ctx.cwd, cfg);
			if (typeof env === "string") {
				ctx.ui.notify(env, "error");
				return;
			}
			const { tree, python } = env;

			const scope = paths.length ? paths : (cfg.scope ?? ["tests/kernel"]);
			const platformArgs = extra.some((a) => PLATFORM_ARGS.test(a))
				? []
				: (cfg.platforms ?? ["native_sim"]).flatMap((p) => ["-p", p]);
			const outdir = join(tmpdir(), "ztwister-out");
			rmSync(outdir, { recursive: true, force: true });
			const args = [
				"scripts/twister",
				"-v",
				"-O",
				outdir,
				...scope.flatMap((p) => ["-T", p]),
				...platformArgs,
				...extra,
			];

			const started = Date.now();
			let done = 0;
			let total = 0;
			let last = "";
			const bad: string[] = [];
			const render = () => {
				const secs = Math.round((Date.now() - started) / 1000);
				const headLine = `ztwister ${scope.join(" ")}: ${done}${total ? `/${total}` : ""} done, ${bad.length} failed, ${secs}s`;
				ctx.ui.setWorkingMessage(headLine);
				const lines = [headLine];
				if (bad.length) lines.push(`  failed: ${bad.slice(-5).join(", ")}${bad.length > 5 ? ", ..." : ""}`);
				if (last) lines.push(`  last: ${last}`);
				ctx.ui.setWidget("ztwister", lines);
			};
			const onLine = (raw: string) => {
				const m = PROGRESS_RE.exec(raw.replace(ANSI_RE, ""));
				if (!m) return;
				done = Number(m[1]);
				total = Number(m[2]);
				last = `${m[3]} ${m[4]} ${m[5]}`;
				if (m[5] === "FAILED" || m[5] === "ERROR") bad.push(`${m[4]}@${m[3]}`);
			};
			const tick = setInterval(render, 1000);
			render();

			try {
				const res = await runStreaming(python, args, {
					cwd: tree,
					signal: ctx.signal,
					timeout: TIMEOUT,
					onLine,
					env: { ZEPHYR_BASE: tree },
				});
				const jsonPath = join(outdir, "twister.json");
				if (!existsSync(jsonPath)) {
					const err = res.output.replace(ANSI_RE, "").trim().split("\n").slice(-20).join("\n");
					ctx.ui.notify(`ztwister produced no report (exit ${res.code}).\n${err}`, "error");
					return;
				}
				const suites: Suite[] = JSON.parse(readFileSync(jsonPath, "utf8")).testsuites ?? [];

				const counts: Record<string, number> = {};
				for (const s of suites) counts[s.status ?? "none"] = (counts[s.status ?? "none"] ?? 0) + 1;
				const n = (k: string) => counts[k] ?? 0;
				const failed = suites.filter((s) => s.status === "failed" || s.status === "error");
				const secs = Math.round((Date.now() - started) / 1000);
				const summary =
					`${n("failed")} failed, ${n("error")} errored, ${n("passed")} passed, ` +
					`${n("skipped")} skipped, ${n("filtered")} filtered` +
					(n("not run") ? `, ${n("not run")} not run` : "") +
					(n("blocked") ? `, ${n("blocked")} blocked` : "");

				const lines = [
					`**ztwister ${scope.join(" ")}${platformArgs.length ? ` (${platformArgs.filter((a) => a !== "-p").join(", ")})` : ""}**: ${summary} (${secs}s)`,
					"",
				];

				/* Group failures by scenario and reason, collecting platforms. */
				const groups = new Map<string, { kind: string; reason: string; suites: Suite[] }>();
				for (const s of failed) {
					const reason = reasonOf(s);
					const key = `${s.name}\0${reason}\0${s.status}`;
					const g = groups.get(key) ?? { kind: s.status === "error" ? "ERROR" : "FAIL", reason, suites: [] };
					g.suites.push(s);
					groups.set(key, g);
				}
				for (const g of [...groups.values()].slice(0, MAX_GROUPS)) {
					const first = g.suites[0];
					const plats = g.suites.map((s) => s.platform);
					const cases = [
						...new Set(
							(first.testcases ?? [])
								.filter((t) => t.status === "failed" || t.status === "error")
								.map((t) => t.identifier ?? "?"),
						),
					];
					lines.push(`**${g.kind}** ${first.name} @ ${plats.join(", ")}`);
					if (cases.length) lines.push(`  testcase: ${cases.slice(0, 3).join(", ")}${cases.length > 3 ? `, +${cases.length - 3} more` : ""}`);
					lines.push(`  reason:   ${g.reason}`);
					const log = bestLog(findBuildDir(outdir, first));
					if (log) lines.push(`  log:      ${log}`);
					const where = first.path ? `-T ${first.path} ` : "";
					lines.push(`  rerun:    ./scripts/twister ${where}-s ${first.name} ${plats.map((p) => `-p ${p}`).join(" ")}`, "");
				}
				if (groups.size > MAX_GROUPS) lines.push(`... ${groups.size - MAX_GROUPS} more failure groups`, "");

				const why = new Map<string, number>();
				for (const s of suites) {
					if (s.status === "skipped" || s.status === "filtered") {
						const r = s.reason?.trim() || "(no reason)";
						why.set(r, (why.get(r) ?? 0) + 1);
					}
				}
				const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
				if (top.length) lines.push(`Skipped/filtered: ${top.map(([r, c]) => `${c} "${r}"`).join(", ")}`);
				if (failed.length === 0) lines.push("No failures.");
				lines.push(`Full report: ${jsonPath}`);

				pi.sendMessage({
					customType: "ztwister",
					content: lines.join("\n"),
					display: true,
					details: { failed: failed.length, total: suites.length },
				});
				ctx.ui.notify(`ztwister: ${summary}`, failed.length ? "error" : "info");
			} finally {
				clearInterval(tick);
				ctx.ui.setWorkingMessage();
				ctx.ui.setWidget("ztwister", undefined);
			}
		},
	});
}
