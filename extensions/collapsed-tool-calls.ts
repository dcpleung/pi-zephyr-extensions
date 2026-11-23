/**
 * Collapsed Tool Calls Extension
 *
 * While a tool row is collapsed, it is drawn as a single line: the tool name in
 * bold followed by its main argument (the bash command, file path, search
 * pattern, ...) (truncated to the terminal width), with the home
 * directory shown as "~". The output is hidden. While a call runs, a live "12s"
 * counter after the tool name shows it is still going; the final duration stays after.
 * Next to it is a byte count, in K (M above 1 MiB), so a quiet-looking call shows it is
 * working: bytes written for write/edit, bytes of output received so far for other tools.
 * Expanding the row (the `app.tools.expand` key, ctrl+o by default) restores the
 * tool's normal rendering, including its full output.
 *
 * Applies to every tool, built-in or not, through `pi.registerToolRenderer()`.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/* Argument names that best describe a call, in order of preference. */
const SUMMARY_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "name", "task", "agent"];

/* Replace the home directory with "~" wherever it starts a path (also inside commands). */
const HOME = homedir().replace(/\/+$/, "");
const HOME_RE = HOME ? new RegExp(`(^|[\\s"'=:(])${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\s"':)]|$)`, "g") : undefined;
const shortenHome = (text: string) => (HOME_RE ? text.replace(HOME_RE, "$1~") : text);

function summarize(args: unknown): string {
	if (args === null || typeof args !== "object") return args === undefined ? "" : String(args);
	const a = args as Record<string, unknown>;
	const key = SUMMARY_KEYS.find((k) => typeof a[k] === "string" && a[k] !== "");
	let text: string;
	if (key) {
		text = String(a[key]);
		/* For file tools, a pattern or path alone is enough; add the path to a pattern search. */
		if (key === "pattern" && typeof a.path === "string") text += ` ${a.path}`;
	} else {
		try {
			text = JSON.stringify(args) ?? "";
		} catch {
			text = "";
		}
		if (text === "{}") text = "";
	}
	return shortenHome(text.replace(/\s+/g, " ").trim());
}

type Styler = { fg(c: any, t: string): string; bg(c: any, t: string): string; bold(t: string): string };

/* Per tool row, shared by renderCall and its timer. */
interface RowState {
	startedAt?: number;
	endedAt?: number;
	/* Row was created already finished (session history): only Pi's durationMs is known. */
	restored?: boolean;
	running?: boolean;
	/* Bytes of output received so far (updated by every partial or final result). */
	outBytes?: number;
	timer?: ReturnType<typeof setInterval>;
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/* Always in K (or M from 1 MiB), one decimal: 0.0K, 12.3K, 1.5M. */
function formatBytes(n: number): string {
	return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}M` : `${(n / 1024).toFixed(1)}K`;
}

const textBytes = (v: unknown) => (typeof v === "string" ? Buffer.byteLength(v, "utf8") : 0);

/* Bytes the model asked a tool to write: the content of write, the new text of edits. */
function writtenBytes(args: unknown): number {
	if (args === null || typeof args !== "object") return 0;
	const a = args as Record<string, unknown>;
	let n = textBytes(a.content);
	if (Array.isArray(a.edits)) for (const e of a.edits) n += textBytes((e as Record<string, unknown>)?.newText);
	return n + textBytes(a.newText);
}

function oneLiner(
	toolName: string,
	args: unknown,
	theme: Styler,
	isError: boolean,
	isPartial: boolean,
	elapsed: () => string | undefined,
	transfer: () => string,
	/* Tools with renderShell "self" (edit) get no panel from Pi: draw the background ourselves. */
	ownPanel: { pad: number } | undefined,
): Component {
	const title = theme.fg(isError ? "error" : "toolTitle", theme.bold(toolName));
	const summary = summarize(args);
	/* Same panel color Pi's tool row uses for its background. */
	const panel = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	/* The opening escape of that background (theme.bg() appends a closing "\x1b[49m"). */
	const bgOpen = theme.bg(panel, "").replace(/\x1b\[49m$/, "");
	return {
		/*
		 * truncateToWidth() ends the kept text and the "..." with a full SGR reset, which also drops the
		 * panel background for the rest of the row. Re-open it after every reset.
		 * The elapsed time sits right after the tool name so truncation never cuts it off.
		 */
		render: (width: number) => {
			const t = elapsed();
			const time = t ? ` ${theme.fg(isPartial ? "accent" : "dim", t)}` : "";
			const io = transfer();
			const line = `${title}${time}${io ? ` ${theme.fg(isPartial ? "accent" : "dim", io)}` : ""}${summary ? ` ${theme.fg("muted", summary)}` : ""}`;
			const w = Math.max(1, width);
			if (!ownPanel) {
				return [truncateToWidth(line, w).replaceAll("\x1b[0m", `\x1b[0m${bgOpen}`)];
			}
			/* Same shape as Pi's default panel: one blank row above and below, horizontal padding, full width. */
			const fill = (text: string) =>
				`${bgOpen}${text}${" ".repeat(Math.max(0, w - visibleWidth(text)))}\x1b[49m`;
			const body = truncateToWidth(`${" ".repeat(ownPanel.pad)}${line}`, w).replaceAll("\x1b[0m", `\x1b[0m${bgOpen}`);
			return [fill(""), fill(body), fill("")];
		},
		invalidate() {},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		return {
			renderShell: base?.renderShell,

			renderCall(args, theme, context) {
				/*
				 * Time the whole call, from the moment the row first appears (while the model is still writing
				 * the arguments, which is the slow part of a large write) to the final result. Pi's own
				 * durationMs only covers the execution, which is near zero for write/edit.
				 */
				const st = context.state as RowState;
				if (st.startedAt === undefined && !context.isPartial) st.restored = true;
				st.startedAt ??= Date.now();
				st.running = context.isPartial;
				if (!st.running) st.endedAt ??= Date.now();
				if (st.running && !st.timer) {
					st.timer = setInterval(() => {
						if (!st.running) {
							clearInterval(st.timer);
							st.timer = undefined;
						}
						context.invalidate();
					}, 1000);
					st.timer.unref?.();
				}
				if (!st.running && st.timer) {
					clearInterval(st.timer);
					st.timer = undefined;
				}

				if (context.expanded && base?.renderCall) {
					return base.renderCall(args, theme, { ...context, lastComponent: undefined });
				}
				const elapsed = () => {
					if (st.restored) return context.durationMs !== undefined ? formatElapsed(context.durationMs) : undefined;
					return st.startedAt !== undefined ? formatElapsed((st.endedAt ?? Date.now()) - st.startedAt) : undefined;
				};
				/* Bytes written (write/edit, from the call) or bytes of output received (grows while it streams). */
				const transfer = () => {
					const up = writtenBytes(context.args);
					/* write/edit only reply with a short status line, so only the bytes written are shown. */
					if (toolName === "write" || toolName === "edit") return up > 0 ? formatBytes(up) : "";
					const down = st.outBytes;
					const parts: string[] = [];
					if (up > 0) parts.push(formatBytes(up));
					if (down !== undefined && (down > 0 || st.running)) parts.push(formatBytes(down));
					else if (st.running) parts.push(formatBytes(0));
					return parts.join(" ");
				};
				return oneLiner(
					toolName,
					args,
					theme,
					context.isError,
					context.isPartial,
					elapsed,
					transfer,
					base?.renderShell === "self" ? { pad: context.outputPad } : undefined,
				);
			},

			renderResult(result, options, theme, context) {
				/* Count the output received so far (tools truncate partial text, so prefer their total). */
				const total = (result.details as { truncation?: { totalBytes?: number } } | undefined)?.truncation?.totalBytes;
				(context.state as RowState).outBytes =
					total ??
					result.content.reduce((n, c) => n + (c.type === "text" ? textBytes((c as { text?: string }).text) : 0), 0);
				if (!options.expanded) return new Container();
				if (base?.renderResult) {
					return base.renderResult(result, options, theme, { ...context, lastComponent: undefined });
				}
				/* No tool-specific renderer: show the raw text, like Pi's own fallback. */
				const text = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				const lines = text ? text.split("\n").map((l) => theme.fg("toolOutput", l)) : [];
				return {
					render: (width: number) => lines.map((l) => truncateToWidth(l, Math.max(1, width))),
					invalidate() {},
				};
			},
		};
	});
}
