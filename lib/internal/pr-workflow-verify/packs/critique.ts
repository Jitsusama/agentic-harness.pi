/**
 * pr-workflow-critique-verify
 *
 * Sibling extension loaded into round-3 critique reviewers
 * via `--extension`. Registers a `verify_output` tool that
 * validates each reviewer's push-back output against the
 * `CritiqueOutput` schema before the subagent ends its run.
 *
 * The critique prompt (taught by the
 * `pr-workflow-critique-output` skill) instructs the
 * reviewer to call `verify_output` and only emit its final
 * fenced JSON block once the call returns `ok: true`. The
 * parent then accepts the verified payload as canonical.
 *
 * Companion skill ships under
 * `skills/pr-workflow-critique-output/`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { critiqueContract } from "../contracts.js";
import { registerVerifyExtension } from "../extension.js";

export default function (pi: ExtensionAPI) {
	registerVerifyExtension(pi, critiqueContract);
}
