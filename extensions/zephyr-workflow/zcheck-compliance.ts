/**
 * Zephyr compliance check (/zcheck-compliance)
 *
 * Runs Zephyr's own PR checks (scripts/ci/check_compliance.py: gitlint, checkpatch,
 * whitespace, Kconfig, devicetree, ...) on the commits between a base ref and HEAD,
 * then shows a digest of only the failing checks.
 *
 *   /zcheck-compliance [base-ref] [-- extra check_compliance.py args, e.g. -m Gitlint -m Checkpatch]
 *
 * Settings (settings.json, key "zcheckCompliance" (or legacy "zcheck"), all optional):
 *   tree    Zephyr tree to check, used when the cwd is not inside one
 *           (default ~/zephyr/rtos/zephyr)
 *   python  Python that has scripts/requirements-compliance.txt installed
 *           (default: a .venv next to or above the tree, else python3)
 *   base    Upstream ref (default: first of zephyr/main, upstream/main, origin/main).
 *           Only commits after the merge-base with HEAD are checked.
 *   args    Extra check_compliance.py arguments (array)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CommonSettings, readSettings, resolveZephyrEnv, runStreaming } from "./zephyr-env.ts";

const SCRIPT = "scripts/ci/check_compliance.py";
const MAX_DETAIL_LINES = 40;

interface Settings extends CommonSettings {
	args?: string[];
}

const unescapeXml = (s: string) =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&");

interface Result {
	name: string;
	status: "fail" | "error" | "skip" | "pass";
	text: string;
}

/* Minimal JUnit reader for the file check_compliance.py writes. */
function parseJunit(xml: string): Result[] {
	const results: Result[] = [];
	const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
	for (const m of xml.matchAll(re)) {
		const name = unescapeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? "?");
		const body = m[2] ?? "";
		const tag = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
		if (!tag) {
			results.push({ name, status: "pass", text: "" });
			continue;
		}
		const message = unescapeXml(/\bmessage="([^"]*)"/.exec(tag[2])?.[1] ?? "");
		const text = unescapeXml((tag[3] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();
		const status = tag[1] === "failure" ? "fail" : tag[1] === "error" ? "error" : "skip";
		results.push({ name, status, text: text || message });
	}
	return results;
}

export function registerZcheckCompliance(pi: ExtensionAPI) {

	pi.registerCommand("zcheck-compliance", {
		description: "Run Zephyr compliance checks (gitlint, checkpatch, ...) on base..HEAD and show failures",
		handler: async (rawArgs, ctx) => {
			const cfg = readSettings<Settings>(pi, "zcheckCompliance");
			const [head, ...rest] = rawArgs.split(/\s+--\s+|\s+--$/);
			const baseArg = head.trim() || undefined;
			const extra = [...(cfg.args ?? []), ...rest.join(" ").trim().split(/\s+/).filter(Boolean)];

			const env = await resolveZephyrEnv(pi, ctx.cwd, cfg, baseArg);
			if (typeof env === "string") {
				ctx.ui.notify(env, "error");
				return;
			}
			/*
			 * The range starts at the merge-base, not at the base tip: check_compliance.py diffs the two
			 * endpoints, so a branch that is behind the base would otherwise pick up everything that
			 * landed upstream since it forked.
			 */
			const { tree, python, base, fork, label } = env;
			const range = `${fork}..HEAD`;
			const count = (await pi.exec("git", ["rev-list", "--count", range], { cwd: tree })).stdout.trim();
			if (count === "0") {
				ctx.ui.notify(`No local commits on top of ${label}; nothing to check`, "warning");
				return;
			}

			const dir = mkdtempSync(join(tmpdir(), "zcheck-compliance-"));
			const out = join(dir, "compliance.xml");
			/* Live progress: the script prints "Running N checks ..." and "Completed <name> ..." lines. */
			const started = Date.now();
			let total = 0;
			const done: string[] = [];
			const running = new Set<string>();
			const render = () => {
				const secs = Math.round((Date.now() - started) / 1000);
				const head = `zcheck-compliance ${base}..HEAD (${count} commit${count === "1" ? "" : "s"}): ${done.length}${total ? `/${total}` : ""} checks done, ${secs}s`;
				ctx.ui.setWorkingMessage(head);
				const lines = [head];
				if (done.length) lines.push(`  done: ${done.join(", ")}`);
				if (running.size) lines.push(`  running: ${[...running].join(", ")}`);
				ctx.ui.setWidget("zcheck-compliance", lines);
			};
			const onLine = (line: string) => {
				let m: RegExpExecArray | null;
				if ((m = /^Running (\d+) checks using/.exec(line))) total = Number(m[1]);
				else if ((m = /^Running (\S.*?)\s+tests in /.exec(line))) running.add(m[1].trim());
				else if ((m = /^Completed (\S.*?)\s+tests in /.exec(line))) {
					done.push(m[1].trim());
					running.delete(m[1].trim());
				} else return;
				render();
			};
			render();
			const tick = setInterval(render, 1000);
			try {
				const res = await runStreaming(python, [SCRIPT, "-c", range, "-o", out, ...extra], {
					cwd: tree,
					signal: ctx.signal,
					timeout: 30 * 60_000,
					onLine,
				});
				const xml = existsSync(out) ? readFileSync(out, "utf8") : "";
				const results = xml ? parseJunit(xml) : [];

				if (results.length === 0) {
					const err = res.output.trim().split("\n").slice(-15).join("\n");
					const hint = /ModuleNotFoundError|No module named/.test(err)
						? `\n\nThe checker's Python dependencies are missing. Install scripts/requirements-compliance.txt into a Python environment and point zcheckCompliance.python at it.`
						: "";
					ctx.ui.notify(`zcheck-compliance produced no results (exit ${res.code}).\n${err}${hint}`, "error");
					return;
				}

				const bad = results.filter((r) => r.status === "fail" || r.status === "error");
				const skipped = results.filter((r) => r.status === "skip");
				const passed = results.length - bad.length - skipped.length;
				const header = `zcheck-compliance ${label}..HEAD (${count} commit${count === "1" ? "" : "s"}) in ${tree}`;
				const summary = `${bad.length} failed, ${passed} passed, ${skipped.length} skipped`;

				const lines = [`**${header}**: ${summary}`, ""];
				for (const r of bad) {
					lines.push(`### ${r.status === "error" ? "ERROR" : "FAIL"}: ${r.name}`);
					const detail = r.text.split("\n");
					lines.push("```", ...detail.slice(0, MAX_DETAIL_LINES));
					if (detail.length > MAX_DETAIL_LINES) lines.push(`... (${detail.length - MAX_DETAIL_LINES} more lines)`);
					lines.push("```", "");
				}
				if (skipped.length) {
					lines.push(
						`Skipped: ${skipped.map((r) => (r.text ? `${r.name} (${r.text.split("\n")[0].slice(0, 60)})` : r.name)).join(", ")}`,
					);
				}
				if (bad.length === 0) lines.push("All checks passed.");

				pi.sendMessage({
					customType: "zcheck-compliance",
					content: lines.join("\n"),
					display: true,
					details: { range, bad: bad.map((r) => r.name) },
				});
				ctx.ui.notify(`zcheck-compliance: ${summary}`, bad.length ? "error" : "info");
			} finally {
				clearInterval(tick);
				ctx.ui.setWorkingMessage();
				ctx.ui.setWidget("zcheck-compliance", undefined);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	});
}
