/**
 * pr-workflow-stack-judge-verify
 *
 * Sibling extension loaded into stack-wide judge subagents
 * via `--extension`. Registers a `verify_output` tool that
 * validates the judge's consolidated stack output against
 * the `StackJudgeOutput` schema (per-PR + cross-PR findings,
 * optional self-signal) before the subagent ends its run.
 *
 * The stack-judge prompt (taught by the
 * `pr-workflow-stack-judge-output` skill) instructs the
 * judge to call `verify_output` and only emit its final
 * fenced JSON block once the call returns `ok: true`. The
 * parent then accepts the verified payload as canonical.
 *
 * Companion skill ships under
 * `skills/pr-workflow-stack-judge-output/`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stackJudgeContract } from "../contracts.js";
import { registerVerifyExtension } from "../extension.js";

export default function (pi: ExtensionAPI) {
	registerVerifyExtension(pi, stackJudgeContract);
}
