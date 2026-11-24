/**
 * Permission Gate Extension
 *
 * When the bash sandbox is active, rules it already enforces are skipped (see SANDBOX_COVERS).
 *
 * Always denies some bash commands (sudo, dd, systemctl, package install/removal,
 * remote code execution, exfiltration, ssh, disk ops)
 * and prompts for confirmation before running other potentially dangerous ones.
 * Patterns: destructive file/git ops, privilege escalation, permissions,
 * system control, curl/wget.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Pattern = { pattern: RegExp; label: string };

/*
 * Rules the bash sandbox (extensions/bash-sandbox.ts) already enforces, by label. They are skipped only
 * while the sandbox is actually active, so they apply again after `/sandbox off` or if bwrap fails.
 *   sandbox  needs root or host access the sandbox removes (no setuid, no devices, own PID namespace,
 *            read-only filesystem)
 *   no-net   only meaningful with the network; skipped while the sandbox has it off
 *   host     needs the host sockets (D-Bus, systemd, Docker); skipped when the sandbox hides them
 */
const SANDBOX_COVERS: Record<string, "sandbox" | "no-net" | "host"> = {
	"privilege escalation": "sandbox",
	dd: "sandbox",
	"system package install/removal": "sandbox",
	"disk / filesystem operation": "sandbox",
	"write to block device": "sandbox",
	"network download": "sandbox",
	"ownership change": "sandbox",
	"setuid/setgid bit": "sandbox",
	"forced process kill": "sandbox",
	"firewall change": "sandbox",
	"user/cron account change": "sandbox",
	systemctl: "host",
	"system shutdown/reboot": "host",
	"network transfer / exfiltration": "no-net",
	"data upload / exfiltration": "no-net",
	"bash network redirection": "no-net",
	"ssh (includes ssh-keygen, ssh-add, ssh-agent, ...)": "no-net",
};

interface SandboxState {
	active: boolean;
	network: boolean;
	hostHidden: boolean;
}

function coveredBySandbox(p: Pattern): boolean {
	const st = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-zephyr.bashSandbox")] as SandboxState | undefined;
	if (!st?.active) return false;
	const kind = SANDBOX_COVERS[p.label];
	if (kind === "sandbox") return true;
	if (kind === "no-net") return !st.network;
	if (kind === "host") return st.hostHidden;
	return false;
}

/* Character ranges of the command matched by any of the patterns, merged and sorted. */
function matchRanges(command: string, patterns: Pattern[]): [number, number][] {
	const ranges: [number, number][] = [];
	for (const { pattern } of patterns) {
		const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
		for (const m of command.matchAll(re)) {
			if (m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([...r]);
	}
	return merged;
}

/*
 * Apply style to the ranges, and plain (if given) to the text between them. Each line piece is
 * styled on its own so wrapping and scrolling keep it.
 */
function highlight(
	command: string,
	ranges: [number, number][],
	style: (t: string) => string,
	plain: (t: string) => string = (t) => t,
): string {
	const styled = (f: (t: string) => string) => (t: string) =>
		t
			.split("\n")
			.map((p) => (p ? f(p) : p))
			.join("\n");
	const hit = styled(style);
	const rest = styled(plain);
	let out = "";
	let pos = 0;
	for (const [a, b] of ranges) {
		out += rest(command.slice(pos, a)) + hit(command.slice(a, b));
		pos = b;
	}
	return out + rest(command.slice(pos));
}

/**
 * Confirmation prompt whose command body scrolls when it does not fit the terminal.
 * The part of the command that matched a dangerous pattern is highlighted.
 * Up/Down pick Yes/No, Enter confirms; Shift+Up/Down, PageUp/PageDown, Home/End
 * scroll the command; y allows; n/Esc denies.
 */
function confirmCommand(ctx: ExtensionContext, command: string, reason: string, matches: Pattern[]): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		let scroll = 0;
		let selected = 0; // 0 = Yes, 1 = No
		let lastMax = 0;
		let lastPage = 1;
		let cachedWidth = -1;
		let wrapped: string[] = [];
		let positioned = false;

		const style = (t: string) => theme.bold(theme.fg("error", t));
		const probe = style("\u0000");
		const styleOpen = probe.slice(0, probe.indexOf("\u0000"));
		const marked = highlight(command, matchRanges(command, matches), style);

		return {
			render(width: number): string[] {
				if (width !== cachedWidth) {
					wrapped = marked
						.split("\n")
						.flatMap((l) => wrapTextWithAnsi(l.replace(/\t/g, "  ") || " ", Math.max(1, width - 2)));
					cachedWidth = width;
				}
				const chrome = 6; // title, blank, blank, Yes, No, hint
				const page = Math.max(3, Math.min(wrapped.length, tui.terminal.rows - chrome - 2));
				const max = Math.max(0, wrapped.length - page);
				lastMax = max;
				lastPage = page;
				if (!positioned) {
					/* Open on the first highlighted line, so the dangerous part is visible. */
					positioned = true;
					const hit = wrapped.findIndex((l) => l.includes(styleOpen));
					if (hit >= 0) scroll = hit - 1;
				}
				scroll = Math.min(Math.max(0, scroll), max);

				const out: string[] = [];
				out.push(truncateToWidth(theme.fg("warning", `⚠️ Dangerous command (${reason}); matched part in `) + style("bold red") + theme.fg("warning", ":"), width));
				out.push("");
				for (const l of wrapped.slice(scroll, scroll + page)) out.push(truncateToWidth(`  ${l}`, width));
				out.push("");
				["Yes", "No"].forEach((label, i) => {
					const line = i === selected ? theme.fg("accent", `→ ${label}`) : `  ${label}`;
					out.push(truncateToWidth(line, width));
				});
				const pos =
					max > 0 ? `lines ${scroll + 1}-${scroll + page} of ${wrapped.length}; Shift+↑↓/PgUp/PgDn scroll` : "";
				out.push(truncateToWidth(theme.fg("dim", `↑↓ select, Enter confirm, Esc cancel${pos ? `; ${pos}` : ""}`), width));
				return out;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.shift("up"))) scroll -= 1;
				else if (matchesKey(data, Key.shift("down"))) scroll += 1;
				else if (matchesKey(data, Key.pageUp)) scroll -= lastPage;
				else if (matchesKey(data, Key.pageDown)) scroll += lastPage;
				else if (matchesKey(data, Key.home)) scroll = 0;
				else if (matchesKey(data, Key.end)) scroll = lastMax;
				else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) selected = 1 - selected;
				else if (matchesKey(data, Key.enter)) return done(selected === 0);
				else if (data === "y" || data === "Y") return done(true);
				else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) return done(false);
				else return;
				tui.requestRender();
			},
			invalidate() {
				cachedWidth = -1;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	// Always denied: blocked outright, no confirmation prompt
	const denyPatterns: Pattern[] = [
		{ pattern: /\b(sudo|su|doas|pkexec)\b/i, label: "privilege escalation" },
		{ pattern: /\bdd\b/i, label: "dd" },
		{ pattern: /\bsystemctl\b/i, label: "systemctl" },
		{
			pattern: /\b(apt(-get)?|aptitude|dpkg|dnf|yum|rpm|pacman|zypper|apk|snap|flatpak|brew)\s+(\S+\s+)*?(install|remove|purge|erase|upgrade|update|autoremove|-[SRUi]\w*|-r)\b/i,
			label: "system package install/removal",
		},
		{
			pattern: /\b(npm|pnpm|yarn|pip3?|pipx|cargo|gem|go)\s+(install|i|add|uninstall|remove|rm)\b/i,
			label: "package install/removal",
		},
		{
			pattern: /\b(curl|wget|fetch)\b.*\|\s*(sudo\s+)?(ba|z|da|k|c|tc)?sh\b/i,
			label: "remote code execution (pipe to shell)",
		},
		{
			pattern: /\b(ba|z|da|k)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b|\b(source|\.)\s+<\(\s*(curl|wget)\b|\beval\b.*\$\(\s*(curl|wget)\b/i,
			label: "remote code execution (execute downloaded script)",
		},
		{
			pattern: /\b(curl|wget|fetch)\b.*\|\s*(python3?|perl|ruby|node|php)\b/i,
			label: "remote code execution (pipe to interpreter)",
		},
		{
			pattern: /\b(nc|ncat|netcat|socat|telnet|scp|sftp|rsync|ftp|tftp)\b/i,
			label: "network transfer / exfiltration",
		},
		{
			pattern: /\b(curl|wget)\b.*(\s-d\s*@|--data(-binary|-raw|-urlencode)?\s*[=\s]?@|\s-F\s*\S*=@|\s-T\s|--upload-file|--post-file|--body-file)/i,
			label: "data upload / exfiltration",
		},
		{ pattern: /\/dev\/(tcp|udp)\//i, label: "bash network redirection" },
		{
			pattern: /\b(mkfs(\.\w+)?|mke2fs|mkswap|swapon|swapoff|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted|wipefs|blkdiscard|badblocks|tune2fs|e2fsck|fsck(\.\w+)?|resize2fs|losetup|cryptsetup|lvm|pvcreate|vgcreate|lvcreate|mdadm|mount|umount)\b/i,
			label: "disk / filesystem operation",
		},
		{
			pattern: /(>|\bof=|\btee\b.*|\bcp\b.*|\bcat\b.*>)\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|loop|dm-|md|mem|kmem|disk|mapper)/i,
			label: "write to block device",
		},
		{ pattern: /\b(ssh|sshfs|mosh|autossh)\b/i, label: "ssh (includes ssh-keygen, ssh-add, ssh-agent, ...)" },
	];

	// Allowed only after user confirmation; the label is shown in the prompt
	const dangerousPatterns: Pattern[] = [
		// Destructive file operations
		{ pattern: /\brm\s+(-\w*[rRf]\w*|--recursive|--force)/i, label: "recursive/forced file removal" },
		{ pattern: /\bshred\b/i, label: "irrecoverable file destruction (shred)" },
		{ pattern: /\btruncate\b/i, label: "file truncation" },
		{ pattern: /\bfind\b.*(-delete|-exec\s+rm)/i, label: "find with file deletion" },
		{ pattern: /\bgit\s+clean\b.*-\w*[fdx]/i, label: "git clean (deletes untracked files)" },
		{ pattern: /\bgit\s+reset\s+--hard/i, label: "git reset --hard (discards changes)" },
		{ pattern: /\bgit\s+push\b.*(--force|-f\b)/i, label: "git force push" },
		// Network downloads (uploads/pipe-to-shell are always denied above)
		{ pattern: /\b(curl|wget)\b/i, label: "network download" },
		// Permissions / ownership
		{ pattern: /\bchmod\b.*(777|-R|--recursive)/i, label: "broad permission change" },
		{ pattern: /\b(chown|chgrp)\b.*(777|-R|--recursive)/i, label: "ownership change" },
		{ pattern: /\bchmod\b.*[ugoa]*\+s\b/i, label: "setuid/setgid bit" },
		// System control
		{ pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i, label: "system shutdown/reboot" },
		{ pattern: /\b(kill|killall|pkill)\b\s+(-9|-KILL|-s\s*KILL)/i, label: "forced process kill" },
		{ pattern: /\b(iptables|nft|ufw)\b/i, label: "firewall change" },
		{ pattern: /\b(crontab\s+-r|userdel|usermod|passwd)\b/i, label: "user/cron account change" },
		// Fork bomb
		{ pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;\s*:/, label: "fork bomb" },
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		const allDenied = denyPatterns.filter((d) => !coveredBySandbox(d) && d.pattern.test(command));
		if (allDenied.length > 0) {
			const labels = [...new Set(allDenied.map((d) => d.label))].join("; ");
			const ranges = matchRanges(command, allDenied);
			if (ctx.hasUI) {
				/* Matched part in bold red, the rest in the warning color the notification is drawn in. */
				const th = ctx.ui.theme;
				const shown = highlight(
					command,
					ranges,
					(t) => th.bold(th.fg("error", t)),
					(t) => th.fg("warning", t),
				);
				ctx.ui.notify(`Denied (${labels}): ${shown}`, "warning");
			}
			const matched = ranges.map(([a, b]) => `"${command.slice(a, b).replace(/\s+/g, " ").trim()}"`).join(", ");
			return { block: true, reason: `Command always denied by policy: ${labels}. Matched: ${matched}` };
		}

		const allDangerous = dangerousPatterns.filter((d) => !coveredBySandbox(d) && d.pattern.test(command));
		const dangerous = allDangerous[0];

		if (dangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: `Dangerous command blocked (${dangerous.label}; no UI for confirmation)` };
			}

			const reason = [...new Set(allDangerous.map((d) => d.label))].join("; ");
			if (!(await confirmCommand(ctx, command, reason, allDangerous))) {
				return { block: true, reason: `Blocked by user (${dangerous.label})` };
			}
		}

		return undefined;
	});
}
