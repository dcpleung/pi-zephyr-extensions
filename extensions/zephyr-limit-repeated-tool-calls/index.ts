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
 * Env:
 *   ZEPHYR_REPEAT_THRESHOLD   identical calls before nudging (default 2, min 2)
 *   ZEPHYR_REPEAT_WINDOW      how many recent calls to look at, including the
 *                             current one (default 10, 0 = since the last user prompt)
 *   ZEPHYR_REPEAT_IGNORE      comma-separated tool names never tracked
 *   ZEPHYR_REPEAT_DISABLE=1   turn the extension off
 */
import { createHash } from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THRESHOLD = Math.max(2, Number.parseInt(process.env.ZEPHYR_REPEAT_THRESHOLD ?? "", 10) || 2);
const WINDOW = (() => {
	const n = Number.parseInt(process.env.ZEPHYR_REPEAT_WINDOW ?? "", 10);
	if (Number.isNaN(n) || n < 0) return 10;
	return n === 0 ? Infinity : Math.max(n, THRESHOLD);
})();
const SCOPE = Number.isFinite(WINDOW) ? `in the last ${WINDOW} tool calls` : "since the last user message";
const IGNORE = new Set(
	(process.env.ZEPHYR_REPEAT_IGNORE ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);

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

function nudge(tool: string, count: number): string {
	const base =
		`[repeated-tool-call] This is call #${count} of \`${tool}\` with identical input and identical output ` +
		`${SCOPE}. Repeating it will not produce new information.`;
	if (count === THRESHOLD) {
		return `${base} Use the result you already have, or change the input (different path, range, pattern or command) if you need something else.`;
	}
	return (
		`${base} Stop repeating this call. Act on the result, try a materially different approach, ` +
		`or, if you are stuck, explain what is blocking you and ask the user.`
	);
}

export default function (pi: ExtensionAPI) {
	if (process.env.ZEPHYR_REPEAT_DISABLE === "1") return;

	/* Keys (tool + input + result) of the most recent tracked calls, oldest first. */
	let recent: string[] = [];
	const reset = () => {
		recent = [];
	};

	pi.on("session_start", async () => reset());
	/* Fires once per user prompt: a new request may legitimately re-run earlier calls. */
	pi.on("before_agent_start", async () => reset());

	pi.on("tool_result", async (event) => {
		if (IGNORE.has(event.toolName)) return;
		/* Nested calls (e.g. from a codemode script) are the parent tool's business. */
		if (event.parentToolCallId) return;

		const key = hash(
			stable({ tool: event.toolName, input: event.input, content: event.content, isError: event.isError }),
		);
		recent.push(key);
		if (recent.length > WINDOW) recent.shift();
		const count = recent.filter((k) => k === key).length;
		if (count < THRESHOLD) return;

		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${nudge(event.toolName, count)}` }],
			/* Keep structured output; only a note was appended. */
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});
}
