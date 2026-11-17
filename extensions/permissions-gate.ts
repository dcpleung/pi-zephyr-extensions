/**
 * Permission Gate Extension
 *
 * Always denies some bash commands (sudo, dd, systemctl, package install/removal,
 * remote code execution, exfiltration, ssh, disk ops)
 * and prompts for confirmation before running other potentially dangerous ones.
 * Patterns: destructive file/git ops, privilege escalation, permissions,
 * system control, curl/wget.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
