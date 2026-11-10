/** The pi a hosted conversation's subagents run: the host's own install, pinned before any extension loads. */
import { realpathSync } from "node:fs";
import type { PiInstall } from "../../lib/subagent/install.ts";
import type { HostPi } from "./host-pi.ts";

/**
 * Where the subagent library takes the parent's install from. Plain pi
 * captures its own on the first dispatch; a hosted conversation's process
 * is the host, whose entry script is not pi's, so the library refuses
 * until the host pins one here.
 */
const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

/**
 * The install a subagent of a hosted conversation runs: the host's node and
 * its pi's command and assets, each dereferenced, so a runtime link moved
 * while the host runs cannot hand a child a pi other than the host's.
 */
export function hostedSubagentInstall(
	pi: Pick<HostPi, "packageDir" | "command">,
	execPath: string = process.execPath,
): PiInstall {
	return {
		node: realpathSync(execPath),
		entry: realpathSync(pi.command),
		packageDir: realpathSync(pi.packageDir),
	};
}

/**
 * Pin the host's pi as every conversation's subagent install. It replaces
 * any capture already taken, which in the host process would name the
 * host's own script.
 */
export function pinSubagentInstall(install: PiInstall): void {
	Reflect.set(globalThis, STARTUP_INSTALL_KEY, install);
}
