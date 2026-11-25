/**
 * Bash Sandbox
 *
 * Replaces the built-in bash tool with one that runs every command inside bubblewrap (bwrap):
 *   - the whole filesystem is read-only, except the working directory ($PWD) and /tmp (and `writable`)
 *   - Pi's agent directory (~/.pi/agent, or $PI_CODING_AGENT_DIR) is usable by a nested `pi`, but
 *     its config and code cannot be changed (see AGENT DIR below)
 *   - credential files are hidden (~/.ssh, ~/.config/gh, ...); `unsetEnv` variables are removed
 *   - the network is OFF by default
 *   - a new PID/IPC/UTS namespace, and a new session (no terminal injection)
 * The permission gate still runs first. The sandbox limits what a confirmed (or missed) command can do,
 * including a script the agent wrote and then ran.
 *
 * Not covered: the write/edit tools (they run in Pi itself), `!cmd` typed by the user, and extension
 * code that spawns processes directly (for example /zfootprint and /ztwister).
 *
 * Hidden by default:
 *   credentials   ~/.ssh ~/.gnupg ~/.config/gh ~/.aws ~/.netrc ~/.git-credentials <agent dir>/auth.json
 *   host sockets  /run/user (user D-Bus, systemd, agents), /run/dbus, /run/docker.sock, /run/containerd,
 *                 /run/podman. A Unix socket can be connected to even on a read-only mount, and
 *                 several of these are root-equivalent. SSH_AUTH_SOCK is not touched: add it to `unsetEnv`.
 *
 * AGENT DIR: a nested `pi` (run from bash) needs to create lock files there and write sessions/.
 * But Pi loads config and code from it, so a writable agent dir would let a sandboxed command turn
 * the sandbox off (settings.json), trust a project (trust.json) or plant code that runs unsandboxed
 * on the next start (extensions/, npm/, bin/ on PATH, ...). So the agent dir is a tmpfs overlay:
 * anything can be written, but writes are thrown away when the command ends. The entries not in
 * AGENT_DIR_PROTECTED (sessions/, zephyr-agent/, ...) are bound through and their changes persist.
 * Without overlay support (bwrap < 0.10 or kernel), only those entries are writable; a nested `pi`
 * then fails to take its lock. A `writable` entry containing the agent dir makes all of it writable.
 *
 * Each bash call row is tagged with how it ran: "sandbox", "sandbox+net", or "no sandbox" (after
 * `/sandbox off`). Rows restored from an earlier session are not tagged: their state is unknown.
 *
 * The permission gate reads this extension's state (see PUBLISHED below) and skips the rules the sandbox
 * already enforces while it is active, and brings them back when the sandbox is off or unavailable.
 *
 * Commands:
 *   /sandbox                 show the state
 *   /sandbox net on|off      allow or block the network for this session
 *   /sandbox on|off          turn the sandbox on or off for this session
 *
 * Settings (settings.json), key "bashSandbox":
 *   enabled    default true
 *   network    default false (the starting value of /sandbox net)
 *   writable   extra read-write paths, on top of $PWD and /tmp, which are always writable
 *              (default ["~/.cache"]; setting it replaces this default)
 *   hide       extra paths hidden from commands, on top of the defaults below
 *   noDefaultHide  default false. true drops the default hide list (not recommended)
 *   gitReadonly  entries of the git directory kept read-only (default ["hooks"]). A hook planted in
 *              .git/hooks would run outside the sandbox on your next git command. "config" is also
 *              risky (core.fsmonitor, aliases) but then `git config` and `git branch -u` fail.
 *   unsetEnv   names of environment variables to remove, e.g. ["GH_TOKEN"] (default: none)
 *   extraArgs  raw bwrap options appended before the command
 *   required   default false. If bwrap does not work, true blocks every bash call; false falls back
 *              to the normal, unsandboxed bash tool and warns.
 * Paths accept "~", "$HOME" and "$PWD".
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	createBashTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

/* Draws another component with a short tag appended to its first line. */
class Tagged implements Component {
	inner: Component;
	tag: string;
	constructor(inner: Component, tag: string) {
		this.inner = inner;
		this.tag = tag;
	}
	render(width: number): readonly string[] {
		const room = visibleWidth(this.tag) + 1;
		if (width <= room + 8) return this.inner.render(width);
		const lines = this.inner.render(width - room);
		if (lines.length === 0) return [this.tag];
		return [`${lines[0]} ${this.tag}`, ...lines.slice(1)];
	}
	invalidate() {
		this.inner.invalidate();
	}
}

export interface SandboxSettings {
	enabled?: boolean;
	network?: boolean;
	writable?: string[];
	hide?: string[];
	noDefaultHide?: boolean;
	gitReadonly?: string[];
	unsetEnv?: string[];
	extraArgs?: string[];
	required?: boolean;
}

/* Always writable, whatever `writable` says. $PWD is added per call. */
const ALWAYS_WRITABLE = ["/tmp"];
const DEFAULT_WRITABLE = ["~/.cache"];
const HIDE_CREDENTIALS = [
	"~/.ssh",
	"~/.gnupg",
	"~/.config/gh",
	"~/.aws",
	"~/.netrc",
	"~/.git-credentials",
];

/* Agent dir entries Pi reads as config or code: never changed from inside the sandbox. */
const AGENT_DIR_PROTECTED = new Set([
	"settings.json",
	"trust.json",
	"models.json",
	"mcp.json",
	"keybindings.json",
	"auth.json",
	"AGENTS.md",
	"CLAUDE.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"extensions",
	"npm",
	"git",
	"agents",
	"skills",
	"prompts",
	"themes",
	"bin",
]);

let overlayOk: boolean | undefined;
/* Whether bwrap can put a tmpfs overlay on dir (needs bwrap >= 0.10 and unprivileged overlayfs). */
function overlayWorks(dir: string): boolean {
	if (overlayOk === undefined) {
		const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--overlay-src", dir, "--tmp-overlay", dir, "true"]);
		overlayOk = r.status === 0;
	}
	return overlayOk;
}

const isInside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const HIDE_HOST_SOCKETS = ["/run/user", "/run/dbus", "/run/docker.sock", "/run/containerd", "/run/podman"];
const DEFAULT_HIDE = [...HIDE_CREDENTIALS, ...HIDE_HOST_SOCKETS];
const DEFAULT_GIT_READONLY = ["hooks"];

/*
 * PUBLISHED: what the permission gate reads, through globalThis, to know which of its rules the
 * sandbox covers right now. Absent (extension off, or bwrap unusable) means nothing is covered.
 */
export const SANDBOX_STATE_KEY = Symbol.for("pi-zephyr.bashSandbox");
export interface PublishedSandboxState {
	/* Commands currently run inside the sandbox. */
	readonly active: boolean;
	/* The network is available inside it. */
	readonly network: boolean;
	/* The host sockets (D-Bus, Docker, user session) are hidden inside it. */
	readonly hostHidden: boolean;
}

const gitCache = new Map<string, { gitDir: string; commonDir: string } | undefined>();

/* The git directory (and the shared one, for a worktree) of cwd, which may sit above or outside cwd. */
function gitDirs(cwd: string) {
	if (gitCache.has(cwd)) return gitCache.get(cwd);
	const r = spawnSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir", "--git-common-dir"], { encoding: "utf8" });
	let out: { gitDir: string; commonDir: string } | undefined;
	if (r.status === 0) {
		const [gitDir, common] = r.stdout.trim().split("\n");
		if (gitDir && common) out = { gitDir, commonDir: resolve(cwd, common) };
	}
	gitCache.set(cwd, out);
	return out;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function expand(p: string, cwd: string): string {
	const home = homedir();
	return p
		.replace(/^~(?=\/|$)/, home)
		.replaceAll("$HOME", home)
		.replaceAll("$PWD", cwd);
}

/* The bwrap argument list (without the command). Exported for tests. */
export function buildBwrapArgs(cfg: SandboxSettings, cwd: string, network: boolean): string[] {
	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];

	const writable = [...ALWAYS_WRITABLE, ...(cfg.writable ?? DEFAULT_WRITABLE), cwd].map((p) => expand(p, cwd));
	for (const p of new Set(writable)) {
		if (existsSync(p)) args.push("--bind", p, p);
	}

	/* AGENT DIR (see the header). Skipped when a configured `writable` entry already covers it. */
	const agentDir = resolve(getAgentDir());
	const configured = (cfg.writable ?? DEFAULT_WRITABLE).map((p) => resolve(expand(p, cwd)));
	if (existsSync(agentDir) && !configured.some((w) => isInside(agentDir, w))) {
		if (overlayWorks(agentDir)) args.push("--overlay-src", agentDir, "--tmp-overlay", agentDir);
		for (const name of readdirSync(agentDir)) {
			if (AGENT_DIR_PROTECTED.has(name)) continue;
			const p = join(agentDir, name);
			args.push("--bind", p, p);
		}
		/* The overlay covered any writable path inside the agent dir (cwd, say): bind those again. */
		for (const p of new Set(writable)) {
			if (existsSync(p) && isInside(resolve(p), agentDir)) args.push("--bind", p, p);
		}
	}

	/*
	 * git needs its own directory writable even when cwd is a subdirectory of the repository or a
	 * worktree whose git directory lives elsewhere. Then keep the parts that run code read-only.
	 */
	const git = gitDirs(cwd);
	if (git) {
		for (const d of new Set([git.gitDir, git.commonDir])) if (existsSync(d)) args.push("--bind", d, d);
		for (const rel of cfg.gitReadonly ?? DEFAULT_GIT_READONLY) {
			const p = resolve(git.commonDir, rel);
			if (!existsSync(p) && rel === "hooks") mkdirSync(p, { recursive: true });
			if (existsSync(p)) args.push("--ro-bind", p, p);
		}
	}

	/* Hide after the binds so a hidden path wins even inside a writable one. */
	const hide = [
		...(cfg.noDefaultHide ? [] : [...DEFAULT_HIDE, join(getAgentDir(), "auth.json")]),
		...(cfg.hide ?? []),
	];
	for (const raw of hide) {
		const e = expand(raw, cwd);
		if (!existsSync(e)) continue;
		const p = realpathSync(e); /* /var/run is a symlink to /run */
		if (statSync(p).isDirectory()) args.push("--tmpfs", p);
		else args.push("--ro-bind", "/dev/null", p);
	}

	args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent");
	if (!network) args.push("--unshare-net");
	for (const v of cfg.unsetEnv ?? []) args.push("--unsetenv", v);
	args.push("--chdir", cwd, ...(cfg.extraArgs ?? []));
	return args;
}

export function wrapCommand(command: string, cfg: SandboxSettings, cwd: string, network: boolean): string {
	const argv = ["bwrap", ...buildBwrapArgs(cfg, cwd, network), "--", "bash", "-c", command];
	return argv.map((a, i) => (i === 0 ? a : shq(a))).join(" ");
}

function bwrapWorks(): string | undefined {
	const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { encoding: "utf8" });
	if (r.error) return `bwrap not runnable: ${r.error.message}`;
	if (r.status !== 0) return `bwrap failed (${r.status}): ${(r.stderr || "").trim()}`;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	/* pi.getSettings() is an action method: it throws during extension loading, so read it lazily. */
	const cfg = (): SandboxSettings => {
		const all = (pi.getSettings() as Record<string, unknown> | undefined) ?? {};
		const v = all.bashSandbox;
		return v && typeof v === "object" ? (v as SandboxSettings) : {};
	};

	let installed = false;
	let published = false;
	let enabled = false;
	let network = false;

	/* Nothing is enforced until setup has run (a previous instance may have left its state behind). */
	delete (globalThis as Record<symbol, unknown>)[SANDBOX_STATE_KEY];

	/*
	 * Tag bash call rows. Registered at load so it is the outermost renderer (extensions load in name
	 * order), which keeps the tag on the collapsed one-line view of collapsed-tool-calls.ts as well.
	 */
	type TagState = { bashSandboxTag?: string | null };
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== "bash" || !base?.renderCall) return base;
		const renderCall = base.renderCall;
		return {
			...base,
			renderCall(args, theme, context) {
				const last = context.lastComponent instanceof Tagged ? context.lastComponent : undefined;
				const inner = renderCall(args, theme, { ...context, lastComponent: last?.inner ?? context.lastComponent });
				const st = context.state as TagState;
				/* Fix the tag when the row first appears; a row first seen finished was restored. */
				if (st.bashSandboxTag === undefined) {
					st.bashSandboxTag = !published || !context.isPartial
						? null
						: !enabled
							? theme.fg("warning", "[no sandbox]")
							: network
								? theme.fg("warning", "[sandbox+net]")
								: theme.fg("dim", "[sandbox]");
				}
				if (!st.bashSandboxTag) return inner;
				if (last) {
					last.inner = inner;
					last.tag = st.bashSandboxTag;
					return last;
				}
				return new Tagged(inner, st.bashSandboxTag);
			},
		};
	});

	/* Runs once, at the first session_start, when settings are readable. */
	const setup = (ctx: ExtensionContext) => {
		if (installed) return;
		installed = true;

		const initial = cfg();
		if (initial.enabled === false) return;
		network = initial.network === true;

		const problem = bwrapWorks();
		if (problem) {
			ctx.ui.notify(`bash sandbox unavailable: ${problem}`, "warning");
			if (initial.required !== true) return;
			const base = createBashTool(process.cwd());
			pi.registerTool({
				...base,
				execute: async () => ({
					content: [{ type: "text", text: `bash is disabled: the sandbox is required but unavailable (${problem}).` }],
					details: {},
				}),
			});
			return;
		}

		enabled = true;
		const bashTool = createBashTool(process.cwd(), {
			spawnHook: ({ command, cwd, env }) =>
				enabled ? { command: wrapCommand(command, cfg(), cwd, network), cwd, env } : { command, cwd, env },
		});

		pi.registerTool({
			...bashTool,
			description:
				`${bashTool.description} Commands run in a bubblewrap sandbox: the filesystem is read-only except ` +
				`the working directory and /tmp, credentials are hidden, and the network may be disabled. ` +
				`Commands that need root or the host fail here by design: sudo/su, dd to devices, mount, mkfs, ` +
				`systemctl, reboot/shutdown, package managers (apt, dnf, ...), iptables, Docker, D-Bus. ` +
				`A "Read-only file system", "Permission denied", "Operation not permitted" or network error from ` +
				`these usually comes from the sandbox, not the command: do not retry or work around it, ` +
				`tell the user what needs to run outside it. (This applies while the sandbox is on.)`,
			execute: async (id, params, signal, onUpdate, _ctx) => bashTool.execute(id, params, signal, onUpdate),
		});

		/* Tell the permission gate what is enforced right now. */
		(globalThis as Record<symbol, unknown>)[SANDBOX_STATE_KEY] = {
			get active() {
				return enabled;
			},
			get network() {
				return network;
			},
			get hostHidden() {
				const c = cfg();
				return !c.noDefaultHide || HIDE_HOST_SOCKETS.every((x) => (c.hide ?? []).includes(x));
			},
		} satisfies PublishedSandboxState;
		published = true;
	};

	pi.on("session_start", async (_e, ctx) => setup(ctx));

	pi.registerCommand("sandbox", {
		description: "Bash sandbox: /sandbox [net on|off | on|off]",
		handler: async (args, ctx) => {
			if (!published) {
				ctx.ui.notify("Bash sandbox is not active (disabled in settings or bwrap unavailable).", "warning");
				return;
			}
			const [a, b] = args.trim().split(/\s+/);
			if (a === "net" && (b === "on" || b === "off")) network = b === "on";
			else if (a === "on" || a === "off") enabled = a === "on";
			else if (a) {
				ctx.ui.notify("Usage: /sandbox [net on|off | on|off]", "warning");
				return;
			}
			ctx.ui.notify(
				enabled
					? `Bash sandbox on. Network ${network ? "ON" : "off"}. Writable: ${[...ALWAYS_WRITABLE, ...(cfg().writable ?? DEFAULT_WRITABLE), "$PWD"].join(", ")}`
					: "Bash sandbox OFF: commands run unrestricted.",
				enabled && !network ? "info" : "warning",
			);
		},
	});
}
