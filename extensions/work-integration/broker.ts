/**
 * The session's tree broker, and the built-in provider under it.
 *
 * Caching belongs here rather than in the library, the way it
 * does for the review engine: the library builds a broker from
 * whatever it is handed, and the extension owns how long one
 * lives.
 *
 * The roster is passed as a function rather than an array, which
 * matters more than it looks. Providers register over the bus and
 * load order between extensions is nobody's choice, so a broker
 * that snapshotted its roster would never consult a provider that
 * registered later. That bug shipped once already, in the broker's
 * own first version.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stateDir } from "../../lib/internal/paths.js";
import type { Exec } from "../../lib/review/index.js";
import {
	createGitTreeProvider,
	createTreeBroker,
	listTreeProviders,
	registerTreeProvider,
	type TreeBroker,
} from "../../lib/work/index.js";

/** Where trees this package cuts are put. */
export function treeDir(): string {
	return join(stateDir("work"), "trees");
}

/** Adapt pi's exec to the library's seam. */
function execFor(pi: ExtensionAPI): Exec {
	return async (command, args) => {
		const result = await pi.exec(command, args);
		return {
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	};
}

/**
 * Register the tree providers this package ships. Idempotent,
 * since the registry survives module reimport but not a reload.
 */
export function registerBuiltinTreeProviders(pi: ExtensionAPI): void {
	registerTreeProvider(
		createGitTreeProvider({ exec: execFor(pi), stateDir: treeDir() }),
	);
}

let broker: TreeBroker | undefined;

/** The session's broker, built on first use. */
export function treeBroker(): TreeBroker {
	if (!broker) broker = createTreeBroker(() => listTreeProviders());
	return broker;
}

/** Drop the cached broker, so the next call rebuilds it. */
export function forgetTreeBroker(): void {
	broker = undefined;
}
