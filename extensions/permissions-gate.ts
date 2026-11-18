/**
 * Permission Gate Extension
 *
 * Always denies some bash commands (sudo, dd, systemctl, package install/removal,
 * remote code execution, exfiltration, ssh, disk ops)
 * and prompts for confirmation before running other potentially dangerous ones.
 * Patterns: destructive file/git ops, privilege escalation, permissions,
 * system control, curl/wget.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Confirmation prompt whose command body scrolls when it does not fit the terminal.
 * Up/Down pick Yes/No, Enter confirms; Shift+Up/Down, PageUp/PageDown, Home/End
 * scroll the command; y allows; n/Esc denies.
 */
function confirmCommand(ctx: ExtensionContext, command: string): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		let scroll = 0;
		let selected = 0; // 0 = Yes, 1 = No
		let lastMax = 0;
		let lastPage = 1;
		let cachedWidth = -1;
		let wrapped: string[] = [];

		return {
			render(width: number): string[] {
				if (width !== cachedWidth) {
					wrapped = command
						.split("\n")
						.flatMap((l) => wrapTextWithAnsi(l.replace(/\t/g, "  ") || " ", Math.max(1, width - 2)));
					cachedWidth = width;
				}
				const chrome = 6; // title, blank, blank, Yes, No, hint
				const page = Math.max(3, Math.min(wrapped.length, tui.terminal.rows - chrome - 2));
				const max = Math.max(0, wrapped.length - page);
				lastMax = max;
				lastPage = page;
				scroll = Math.min(Math.max(0, scroll), max);

				const out: string[] = [];
				out.push(truncateToWidth(theme.fg("warning", "⚠️ Dangerous command:"), width));
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
	const denyPatterns: { pattern: RegExp; label: string }[] = [
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

	const dangerousPatterns = [
		// Destructive file operations
		/\brm\s+(-\w*[rRf]\w*|--recursive|--force)/i,
		/\bshred\b/i,
		/\btruncate\b/i,
		/\bfind\b.*(-delete|-exec\s+rm)/i,
		/\bgit\s+clean\b.*-\w*[fdx]/i,
		/\bgit\s+reset\s+--hard/i,
		/\bgit\s+push\b.*(--force|-f\b)/i,
		// Network downloads (uploads/pipe-to-shell are always denied above)
		/\b(curl|wget)\b/i,
		// Permissions / ownership
		/\b(chmod|chown|chgrp)\b.*(777|-R|--recursive)/i,
		/\bchmod\b.*[ugoa]*\+s\b/i,
		// System control
		/\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i,
		/\b(kill|killall|pkill)\b\s+(-9|-KILL|-s\s*KILL)/i,
		/\b(iptables|nft|ufw)\b/i,
		/\b(crontab\s+-r|userdel|usermod|passwd)\b/i,
		// Fork bomb
		/:\(\)\s*\{.*\|.*&.*\}\s*;\s*:/,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		const denied = denyPatterns.find((d) => d.pattern.test(command));
		if (denied) {
			if (ctx.hasUI) ctx.ui.notify(`Denied (${denied.label}): ${command}`, "warning");
			return { block: true, reason: `Command always denied by policy: ${denied.label}` };
		}

		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			if (!(await confirmCommand(ctx, command))) {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
