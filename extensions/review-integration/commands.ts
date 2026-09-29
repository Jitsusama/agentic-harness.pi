/**
 * Where the review tools' git and gh commands run.
 *
 * Unattended, not through pi's exec: pi's child shares pi's terminal, so a
 * git wanting a password or a gh wanting a login drew its prompt over pi's
 * interface and waited for keys that never reached it.
 *
 * One seam for the whole extension, bound late so the engine and the
 * providers, built once, still run through whatever is in place when a
 * command is issued. Only a test puts anything else there.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Exec } from "@jitsusama/agentic-harness.core/exec";
import { UNATTENDED_HOST } from "../../lib/internal/unattended-exec.ts";

type Runner = Pick<ExtensionAPI, "exec">;

let runner: Runner = UNATTENDED_HOST;

/** Run the extension's commands through `host` instead, for a test. */
export function runCommandsWith(host: Runner | undefined): void {
	runner = host ?? UNATTENDED_HOST;
}

/** The extension's commands, in the shape of a host's exec. */
export const REVIEW_COMMANDS: Runner = {
	exec: (command, args, options) => runner.exec(command, args, options),
};

/** The extension's commands, in the shape of the library's exec seam. */
export const reviewExec: Exec = async (command, args) => {
	const { code, stdout, stderr } = await runner.exec(command, [...args]);
	return { code, stdout, stderr };
};
