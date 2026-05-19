/**
 * Resolve the absolute path to the sibling
 * pr-workflow-verify extension's entry point.
 *
 * Used by `index.ts` to compose the `--extension <path>`
 * flag that every reviewer subagent receives, so the
 * subagent can call `verify_output` to self-check its
 * JSON before ending the run.
 *
 * The path is computed from `import.meta.url`: jiti
 * resolves the extension's source location at load time
 * and reports it through `import.meta.url`. The sibling
 * extension sits one directory across so a single
 * relative URL takes us there regardless of where the
 * package is installed.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Absolute filesystem path to
 * `extensions/pr-workflow-verify/index.ts`. Throws if
 * the file isn't on disk: that indicates a packaging
 * bug, and continuing would silently disable
 * self-verify in every reviewer.
 */
export function resolveVerifyExtensionPath(): string {
	const url = new URL("../pr-workflow-verify/index.ts", import.meta.url);
	const path = fileURLToPath(url);
	if (!existsSync(path)) {
		throw new Error(
			`pr-workflow-verify entry not found at ${path}. ` +
				"The sibling extension must be co-located with pr-workflow " +
				"for reviewer self-verify to work.",
		);
	}
	return path;
}
