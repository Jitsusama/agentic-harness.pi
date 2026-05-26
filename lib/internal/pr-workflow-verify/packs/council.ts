/**
 * pr-workflow-council-verify
 *
 * Sibling extension loaded into council (round 1) reviewer
 * subagents via `--extension`. Registers a `verify_output`
 * tool that validates the reviewer's proposed JSON against
 * the round-1 `CouncilFindingsOutput` schema before the
 * subagent ends its run.
 *
 * The reviewer's prompt (taught by the
 * `pr-workflow-council-output` skill) instructs it to call
 * `verify_output` and only emit its final fenced JSON block
 * once the call returns `ok: true`. The parent then accepts
 * the verified payload as canonical.
 *
 * One extension per stage so each subagent only sees the
 * schema it needs, and so each stage's contract can evolve
 * independently. Companion skill ships under
 * `skills/pr-workflow-council-output/`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { councilContract } from "../contracts.js";
import { registerVerifyExtension } from "../extension.js";

export default function (pi: ExtensionAPI) {
	registerVerifyExtension(pi, councilContract);
}
