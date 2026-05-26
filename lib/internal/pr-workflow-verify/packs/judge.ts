/**
 * pr-workflow-judge-verify
 *
 * Sibling extension loaded into round-2 judge subagents via
 * `--extension`. Registers a `verify_output` tool that
 * validates the judge's consolidated output against the
 * `JudgeOutput` schema before the subagent ends its run.
 *
 * The judge's prompt (taught by the
 * `pr-workflow-judge-output` skill) instructs it to call
 * `verify_output` and only emit its final fenced JSON block
 * once the call returns `ok: true`. The parent then accepts
 * the verified payload as canonical.
 *
 * Companion skill ships under
 * `skills/pr-workflow-judge-output/`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { judgeContract } from "../contracts.js";
import { registerVerifyExtension } from "../extension.js";

export default function (pi: ExtensionAPI) {
	registerVerifyExtension(pi, judgeContract);
}
