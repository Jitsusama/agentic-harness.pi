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
	type Objection,
	type PublishIntent,
	registerTreeProvider,
	type TreeBroker,
	WORK_PUBLISH_CHECK,
} from "../../lib/work/index.js";

/** Where trees this package cuts are put. */
export function treeDir(): string {
	return join(stateDir("work"), "trees");
}

/**
 * Adapt pi's exec to the library's seam.
 *
 * Exported because the tool builds a history and an author of its
 * own, and three call sites reaching for the same six lines is
 * what a shared helper is for.
 */
export function execFor(pi: ExtensionAPI): Exec {
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

/**
 * How long to wait for anybody to object to a publish.
 *
 * A listener has to reach a backend to answer, so this cannot be instant. It is
 * short because the failure mode of waiting is worse than the failure mode of
 * not: a push that hangs looks broken, while a push that goes ahead is what
 * would have happened anyway without the check.
 */
const OBJECTION_GRACE_MS = 4000;

/**
 * Ask whether anybody objects to publishing, and collect what comes back.
 *
 * Advisory on purpose. A listener that throws, hangs or is not there does not
 * stop a push, because a working layer that stops working when an unrelated
 * extension has a bad day is worse than one that occasionally publishes
 * something it might have been warned about.
 *
 * The wait is bounded for the same reason. Nothing is required to answer, so
 * there is no completion to wait for, only a grace period.
 */
export async function objectionsTo(
	pi: ExtensionAPI,
	intent: PublishIntent,
): Promise<readonly Objection[]> {
	const objections: Objection[] = [];
	const pending: Promise<unknown>[] = [];
	try {
		pi.events.emit(WORK_PUBLISH_CHECK, {
			intent,
			object(objection: Objection) {
				objections.push(objection);
			},
			// A listener that needs to reach a backend hands back its promise,
			// so the wait is as long as the answer takes rather than a guess.
			waitFor(work: Promise<unknown>) {
				pending.push(work);
			},
		});
	} catch {
		// A throwing listener is that listener's problem. It does not get to
		// decide whether this push happens.
		return objections;
	}
	if (pending.length > 0) {
		await Promise.race([
			Promise.allSettled(pending),
			new Promise((done) => setTimeout(done, OBJECTION_GRACE_MS)),
		]);
	}
	return objections;
}
