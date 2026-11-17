/**
 * Protected Paths Extension
 *
 * Blocks read/write access to credentials and critical system files, and
 * write/edit access to system-integrity paths, shell startup files and
 * project metadata. Also does a best-effort scan of bash commands.
 *
 * NOTE: this is not a sandbox. Use bubblewrap/Landlock/containers for
 * real enforcement.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";

const home = homedir();

// Blocked for read and write
const noAccess: RegExp[] = [
	/(^|\/)\.env(\..*)?$/,
	/(^|\/)\.envrc$/,
	/(^|\/)\.netrc$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.pypirc$/,
	/(^|\/)\.git-credentials$/,
	/\/\.ssh\//,
	/\/\.gnupg\//,
	/\/\.aws\//,
	/\/\.azure\//,
	/\/\.kube\//,
	/\/\.config\/gcloud\//,
	/\/\.config\/gh\//,
	/\/\.docker\/config\.json$/,
	/\/\.pi\/agent\/auth\.json$/,
	/\/\.password-store\//,
	/\/\.local\/share\/keyrings\//,
	/_history$/,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)[^/]*$/, // id_rsa, id_ed25519.pub, id_ecdsa_sk, ...
	/\.(pem|key|p12|pfx)$/,
	/^\/etc\/(shadow|gshadow|sudoers(\.d\/.*)?)$/,
	/^\/etc\/ssh\//,
	/^\/etc\/ssl\/private\//,
	/^\/root(\/|$)/,
	/^\/proc\/kcore$/,
	/^\/proc\/[^/]+\/(mem|environ)$/,
	/^\/dev\/(mem|kmem|sd.*|nvme.*|disk\/.*)$/,
];

// Blocked for write/edit only
const noWrite: RegExp[] = [
	/^\/(boot|etc|usr|bin|sbin|lib|lib64|opt|var\/lib|sys|proc|dev)\//,
	/^\/var\/spool\/cron\//,
	/(^|\/)\.git\//,
	/(^|\/)node_modules\//,
	/(^|\/)\.github\/workflows\//,
	/(^|\/)\.(bashrc|bash_profile|profile|zshrc|zshenv)$/,
	/\/\.config\/(autostart|systemd\/user)\//,
];

// Best-effort patterns for bash commands (substring/regex over the command text)
const bashPatterns: RegExp[] = [
	/(^|[\s'"=])(~|\$HOME|\/home\/[^/\s]+)\/\.(ssh|gnupg|aws|azure|kube|password-store)(\/|\s|$|['"])/,
	/(^|[\s'"=\/])\.env(\.[\w.-]+)?(\s|$|['"])/,
	/\/etc\/(shadow|gshadow|sudoers)/,
	/\/etc\/ssh\//,
	/\/root\//,
	/\.git-credentials|\.netrc|\.pypirc/,
	/(^|[\s'\"=\/])id_(rsa|ed25519|ecdsa|dsa)[\w.-]*/,
	/\/proc\/(kcore|[^/\s]+\/(mem|environ))/,
	/\/dev\/(mem|kmem|sd\w*|nvme\w*)/,
	/\b_?history\b.*\/\.\w+_history|\/\.\w+_history/,
];

function normalize(raw: string): string {
	let p = raw.replace(/^@/, "").replace(/^~(?=$|\/)/, home);
	p = resolve(p);
	// Resolve symlinks; if the file doesn't exist, resolve its parent.
	try {
		return realpathSync(p);
	} catch {
		try {
			return join(realpathSync(dirname(p)), basename(p));
		} catch {
			return p;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const name = event.toolName;

		if (name === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			if (bashPatterns.some((r) => r.test(cmd))) {
				if (ctx.hasUI) ctx.ui.notify(`Blocked bash command touching protected path`, "warning");
				return { block: true, reason: "Command references a protected path" };
			}
			return undefined;
		}

		const writing = name === "write" || name === "edit";
		const reading = ["read", "grep", "find", "ls"].includes(name);
		if (!writing && !reading) return undefined;

		const raw = ((event.input as { path?: string }).path ?? ".") as string;
		const candidates = new Set([resolve(raw.replace(/^~(?=$|\/)/, home)), normalize(raw)]);
		const rules = writing ? [...noAccess, ...noWrite] : noAccess;

		for (const path of candidates) {
			if (rules.some((r) => r.test(path))) {
				if (ctx.hasUI) ctx.ui.notify(`Blocked ${name}: ${path}`, "warning");
				return { block: true, reason: `Path "${path}" is protected` };
			}
		}
		return undefined;
	});
}
