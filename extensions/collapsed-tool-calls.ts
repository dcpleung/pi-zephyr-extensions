/**
 * Collapsed Tool Calls Extension
 *
 * While a tool row is collapsed, it is drawn as a single line: the tool name in
 * bold followed by its main argument (the bash command, file path, search
 * pattern, ...) (truncated to the terminal width), with the home
 * directory shown as "~". The output is hidden.
 * Expanding the row (the `app.tools.expand` key, ctrl+o by default) restores the
 * tool's normal rendering, including its full output.
 *
 * Applies to every tool, built-in or not, through `pi.registerToolRenderer()`.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";

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

function oneLiner(toolName: string, args: unknown, theme: Styler, isError: boolean, isPartial: boolean): Component {
	const title = theme.fg(isError ? "error" : "toolTitle", theme.bold(toolName));
	const summary = summarize(args);
	const line = summary ? `${title} ${theme.fg("muted", summary)}` : title;
	/* Same panel color Pi's tool row uses for its background. */
	const panel = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	/* The opening escape of that background (theme.bg() appends a closing "\x1b[49m"). */
	const bgOpen = theme.bg(panel, "").replace(/\x1b\[49m$/, "");
	return {
		/*
		 * truncateToWidth() ends the kept text and the "..." with a full SGR reset, which also drops the
		 * panel background for the rest of the row. Re-open it after every reset.
		 */
		render: (width: number) => [truncateToWidth(line, Math.max(1, width)).replaceAll("\x1b[0m", `\x1b[0m${bgOpen}`)],
		invalidate() {},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		return {
			renderShell: base?.renderShell,

			renderCall(args, theme, context) {
				if (context.expanded) {
					if (base?.renderCall) return base.renderCall(args, theme, { ...context, lastComponent: undefined });
					return oneLiner(toolName, args, theme, context.isError, context.isPartial);
				}
				return oneLiner(toolName, args, theme, context.isError, context.isPartial);
			},

			renderResult(result, options, theme, context) {
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
