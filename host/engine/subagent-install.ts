/** The pi a hosted conversation's subagents run, and the key they run on: the host's own, pinned before any extension loads. */
import { realpathSync } from "node:fs";
import { pinChildEnvironment } from "../../lib/subagent/child-env.ts";
import type { PiInstall } from "../../lib/subagent/install.ts";
import type { EngineKey } from "./contract.ts";
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

/**
 * Hand every conversation's subagents the host's current gateway key,
 * under each of `names`, the variables the work provider reads it from.
 * A terminal pi's children inherit the key its launcher exported; the
 * host's own environment holds none, so without this a subagent refuses
 * with "No API key found" before it answers. Each start asks the key
 * afresh, so a child never starts on one the host has since renewed.
 */
export function pinSubagentKey(
	key: Pick<EngineKey, "current">,
	names: readonly string[],
): void {
	pinChildEnvironment(async () => {
		const current = await key.current().catch((error: unknown) => {
			throw new Error(
				`The host couldn't resolve its gateway key for a subagent: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		});
		return Object.fromEntries(names.map((name) => [name, current]));
	});
}
