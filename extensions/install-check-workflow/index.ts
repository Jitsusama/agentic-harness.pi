/**
 * Install Check Workflow Extension
 *
 * Says when the code running is not the code on disk, or not the code
 * the install was meant to hold. A pulled checkout is not reinstalled
 * and a running pi is not reloaded, so both drift silently: an import
 * of a dependency's new export reads `undefined`, or a merged fix sits
 * on disk for days while the session runs the version before it.
 *
 * - At session start: each dependency's installed version against the
 *   range in `package.json`, naming the install command when one falls
 *   outside it, and how far the checkout is behind its upstream as of
 *   the last fetch.
 * - After each run, at most every ten minutes: whether the checkout's
 *   HEAD moved since this code loaded, once per new HEAD, with the
 *   dependency check again, since a pull is what moves both.
 *
 * Each notice is said once a conversation. Every reading is taken once
 * for all the conversations this load of the code serves, since a host
 * runs them all on one loop: HEAD and the upstream at most every ten
 * minutes, the dependencies again only when HEAD moves. Without git,
 * as on an npm install, only the dependency check runs.
 */

import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { unbuiltDependencies } from "../../lib/internal/install/builds.ts";
import {
	dependencyStandings,
	describeDrift,
	drifted,
} from "../../lib/internal/install/drift.ts";
import { headWatch } from "../../lib/internal/install/head.ts";
import { sharedReading } from "../../lib/internal/install/reading.ts";
import {
	behindNotice,
	driftNotice,
	moveNotice,
	unbuiltNotice,
} from "./notice.ts";
import {
	commitsBehind,
	dependencyRanges,
	headOf,
	installCommand,
	installedVersion,
} from "./probe.ts";

/** The least time between two reads of HEAD. */
const HEAD_INTERVAL_MS = 10 * 60_000;

/** The package this extension ships in. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Taken at load, not at session start: a new session runs the code this
// load holds, and a reload evaluates this module again.
const loadedHead = headOf(PACKAGE_ROOT);
const headNow = sharedReading(() => headOf(PACKAGE_ROOT), {
	maxAgeMs: HEAD_INTERVAL_MS,
});
const behindNow = sharedReading(() => commitsBehind(PACKAGE_ROOT), {
	maxAgeMs: HEAD_INTERVAL_MS,
});
/** The install's notices, read again for the HEAD that moved. */
const installNotices = sharedReading<string, string[]>(() =>
	dependencyNotices(),
);

/** What the install says of its dependencies, as notices. */
function dependencyNotices(): string[] {
	const notices: string[] = [];
	const skipped = unbuiltDependencies(PACKAGE_ROOT);
	if (skipped.length > 0) notices.push(unbuiltNotice(skipped));
	const drift = drifted(
		dependencyStandings(dependencyRanges(PACKAGE_ROOT), (name) =>
			installedVersion(PACKAGE_ROOT, name),
		),
	);
	if (drift.length > 0)
		notices.push(
			driftNotice(describeDrift(drift), installCommand(PACKAGE_ROOT)),
		);
	return notices;
}

export default function installCheckWorkflow(pi: ExtensionAPI) {
	const watch = headWatch({
		loaded: loadedHead,
		read: () => headNow(),
		intervalMs: HEAD_INTERVAL_MS,
	});
	const said = new Set<string>();
	const say = (ctx: ExtensionContext, text: string) => {
		if (!ctx.hasUI || said.has(text)) return;
		said.add(text);
		ctx.ui.notify(text, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		for (const notice of installNotices()) say(ctx, notice);
		// Not awaited: a slow git is no reason to hold up the session.
		void behindNow().then((behind) => {
			if (behind) say(ctx, behindNotice(behind));
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		const move = await watch.check();
		if (!move) return;
		say(ctx, moveNotice(move));
		for (const notice of installNotices(move.now)) say(ctx, notice);
	});
}
