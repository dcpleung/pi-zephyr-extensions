/**
 * Export Theme Extension
 *
 * `/export-theme [name]` snapshots the current theme (including the generated `system`
 * theme, built from your terminal's current colors) as a JSON theme in
 * `<agent-dir>/themes/<name>.json`, so you can edit it by hand. Select it afterwards
 * via /settings (hot-reloaded on edit).
 *
 * All tokens are written as resolved hex values, so `vars` and okhsl() values of a
 * source theme are flattened. Tokens that follow the terminal defaults are resolved
 * to the terminal's reported (or guessed) fg/bg, and faint tokens are written as
 * their approximate blended color.
 */

import fs from "node:fs";
import path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("export-theme", {
		description: "Export the current theme as an editable JSON theme (default name: <current>-custom)",
		handler: async (args, ctx) => {
			const current = ctx.ui.theme;
			const name = args.trim() || `${current.name ?? "theme"}-custom`;
			if (name === "system" || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
				ctx.ui.notify(`Invalid theme name "${name}" ("system" is reserved; no slashes or leading dots)`, "error");
				return;
			}

			const colors = Object.fromEntries(
				Object.entries(current.colors)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([token, color]) => [token, colorToHex(color)]),
			);
			const theme = {
				$schema: "https://pi.dev/schemas/theme.schema.json",
				name,
				appearance: current.appearance,
				vars: {},
				colors,
			};

			const file = path.join(getAgentDir(), "themes", `${name}.json`);
			if (fs.existsSync(file) && !(await ctx.ui.confirm("Overwrite theme?", `${file} already exists.`))) {
				return;
			}
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify(theme, null, "\t")}\n`);
			ctx.ui.notify(`Wrote ${file}. Select "${name}" in /settings, then edit the file.`, "info");
		},
	});
}
