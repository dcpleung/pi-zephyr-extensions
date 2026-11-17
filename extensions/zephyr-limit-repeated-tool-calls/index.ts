/*
 * Nudge the model when it repeats a tool call that produced the same result.
 *
 * A call is "repeated" when the tool name, the input and the result (content and
 * error flag) are all identical to an earlier call among the last WINDOW tracked
 * calls since the last user prompt. Calls in between do not matter, so loops like
 * a, b, c, a, b, c are caught; an occasional re-check long after is not.
 * From the THRESHOLD-th identical call on, a note is appended to the tool result
 * telling the model that nothing changed and to try something else. The tool still
 * runs and its output is kept, so legitimate re-checks are not broken.
 *
 * Settings (settings.json, key "zephyrLimitRepeatedToolCalls"; re-read on every
 * tool call, so /reload picks up changes). Defaults apply when unset:
 *   threshold  identical calls before nudging (default 2, min 2)
 *   window     how many recent calls to look at, including the current one
 *              (default 10, 0 = since the last user prompt)
 *   ignore     array of tool names never tracked
 *   enabled    false turns the extension off
 */
import { createHash } from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* Settings live under this key in settings.json (global or project). */
const SETTINGS_KEY = "zephyrLimitRepeatedToolCalls";

interface Config {
	threshold: number;
	window: number;
	ignore: Set<string>;
	disabled: boolean;
	scope: string;
}

function toInt(v: unknown): number | undefined {
	const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
	return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function loadConfig(pi: ExtensionAPI): Config {
	const raw = (pi.getSettings() as Record<string, unknown>)[SETTINGS_KEY];
	const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

	const threshold = Math.max(2, toInt(s.threshold) ?? 2);

	const w = toInt(s.window);
	const window = w === undefined || w < 0 ? 10 : w === 0 ? Infinity : Math.max(w, threshold);

	const ign = s.ignore ?? [];
	const names = Array.isArray(ign) ? ign.map(String) : String(ign).split(",");
	const ignore = new Set(names.map((n) => n.trim()).filter(Boolean));

	const disabled = s.enabled === false;

	const scope = Number.isFinite(window) ? `in the last ${window} tool calls` : "since the last user message";
	return { threshold, window, ignore, disabled, scope };
}

/* JSON with sorted object keys, so {a,b} and {b,a} hash the same. */
function stable(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.filter((k) => o[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function nudge(cfg: Config, tool: string, count: number): string {
	const base =
		`[repeated-tool-call] This is call #${count} of \`${tool}\` with identical input and identical output ` +
		`${cfg.scope}. Repeating it will not produce new information.`;
	if (count === cfg.threshold) {
		return `${base} Use the result you already have, or change the input (different path, range, pattern or command) if you need something else.`;
	}
	return (
		`${base} Stop repeating this call. Act on the result, try a materially different approach, ` +
		`or, if you are stuck, explain what is blocking you and ask the user.`
	);
}

export default function (pi: ExtensionAPI) {
	/* Keys (tool + input + result) of the most recent tracked calls, oldest first. */
	let recent: string[] = [];
	const reset = () => {
		recent = [];
	};

	pi.on("session_start", async () => reset());
	/* Fires once per user prompt: a new request may legitimately re-run earlier calls. */
	pi.on("before_agent_start", async () => reset());

	pi.on("tool_result", async (event) => {
		/* Re-read each call so edits followed by /reload apply without a restart. */
		const cfg = loadConfig(pi);
		if (cfg.disabled || cfg.ignore.has(event.toolName)) return;
		/* Nested calls (e.g. from a codemode script) are the parent tool's business. */
		if (event.parentToolCallId) return;

		const key = hash(
			stable({ tool: event.toolName, input: event.input, content: event.content, isError: event.isError }),
		);
		recent.push(key);
		if (recent.length > cfg.window) recent.shift();
		const count = recent.filter((k) => k === key).length;
		if (count < cfg.threshold) return;

		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${nudge(cfg, event.toolName, count)}` }],
			/* Keep structured output; only a note was appended. */
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});
}
