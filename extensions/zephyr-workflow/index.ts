/*
 * Zephyr RTOS workflow: /zbrainstorm, /zplan, /zwork, /zreview, /zcompound, /zissue-review, /zfeature, /zcheck-compliance, /zfootprint, /ztwister.
 * Skills, prompts and subagent definitions live next to this file; the subagent
 * tool itself is provided by the sibling "zephyr-subagents" sub-extension.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflow } from "./workflow.ts";
import { registerZcheckCompliance } from "./zcheck-compliance.ts";
import { registerZfootprint } from "./zfootprint.ts";
import { registerZissueReview } from "./zissue-review.ts";
import { registerZtwister } from "./ztwister.ts";

export default function (pi: ExtensionAPI) {
	const workflow = registerWorkflow(pi, {
		name: "Zephyr",
		id: "zephyr-agent",
		envPrefix: "ZEPHYR_AGENT",
		toolName: "zephyr_agent_artifact_path",
		toolLabel: "Zephyr artifact path",
		featureCommand: "zfeature",
		title: "Zephyr agent artifacts",
		repoNoun: "Zephyr repository",
		resourceDir: dirname(fileURLToPath(import.meta.url)),
	});
	registerZcheckCompliance(pi);
	registerZfootprint(pi);
	registerZtwister(pi);
	registerZissueReview(pi, workflow);
}
