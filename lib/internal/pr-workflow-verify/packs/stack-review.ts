/**
 * pr-workflow-stack-review-verify
 *
 * Sibling extension loaded into stack-wide reviewer
 * subagents via `--extension`. Registers a `verify_output`
 * tool that validates the reviewer's output against the
 * `StackReviewOutput` schema (per-PR + cross-PR findings)
 * before the subagent ends its run.
 *
 * The stack-review prompt (taught by the
 * `pr-workflow-stack-review-output` skill) instructs the
 * reviewer to call `verify_output` and only emit its final
 * fenced JSON block once the call returns `ok: true`. The
 * parent then accepts the verified payload as canonical.
 *
 * Companion skill ships under
 * `skills/pr-workflow-stack-review-output/`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stackReviewContract } from "../contracts.js";
import { registerVerifyExtension } from "../extension.js";

export default function (pi: ExtensionAPI) {
	registerVerifyExtension(pi, stackReviewContract);
}
