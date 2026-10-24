/**
 * A reload, from the agent asking to the new code saying it landed.
 *
 * pi gives `reload()` only to a command's context, never to a tool's,
 * and reloading under a run that is still streaming would pull the
 * tools out from under it. So the tool only asks. When the run ends the
 * request goes to `/harness reload` through pi's own prompt path, which
 * dispatches a command with a full command context; the command waits
 * for the session to be idle, points the settings at the tree when there
 * is one, reloads, and puts the settings back whatever happened.
 */

import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	checkLoad,
	describeLoad,
} from "../../lib/internal/reload/load-check.ts";
import {
	homely,
	isSwapped,
	type Loaded,
} from "../../lib/internal/reload/loaded.ts";
import {
	entryFor,
	type PackageSettings,
	packageName,
	pointEntryAt,
	type Restore,
} from "../../lib/internal/reload/settings.ts";
import {
	type ReloadRequest,
	reloadSlot,
} from "../../lib/internal/reload/slot.ts";
import { getParentPiInstall } from "../../lib/subagent/install.ts";
import { canonical, PACKAGE_NAME } from "./lifecycle.ts";

/** What `onto` says to mean the install pi's settings name. */
export const INSTALLED = "installed";

/** How long the session must stay idle, with nothing queued, to reload. */
export const STILL_MS = 1_000;

/**
 * Wait until the session is idle and stays so with nothing queued.
 *
 * `waitForIdle` resolves the moment a run ends, and a run often does
 * not stay ended: a compaction that cut it short finishes and sends
 * the message that resumes it tens of milliseconds later. Reloading in
 * that gap pulled the tools out from under the resumed run's first
 * call. So the session has to be still for a moment, and is looked at
 * again after every wait.
 *
 * pi's word is not the only one asked. `underWay` says whether a run has
 * started since the last one settled, from the run's own events, and a
 * reload waits while it does. On 22 October six tool calls in four
 * sessions failed on a stale context after the session reloaded itself.
 * In the three read closely, the new code started 2.5 to 3.6 seconds
 * into the first reply of a run a compaction had resumed, so this wait
 * had passed while that run was streaming. Answers how many times pi
 * said still while a run was under way, which is evidence for whoever
 * looks next.
 */
export async function untilStill(
	ctx: Pick<
		ExtensionCommandContext,
		"waitForIdle" | "isIdle" | "hasPendingMessages"
	>,
	stillMs: number = STILL_MS,
	underWay: () => boolean = () => false,
): Promise<number> {
	let overruled = 0;
	for (;;) {
		await ctx.waitForIdle();
		await new Promise((done) => setTimeout(done, stillMs));
		if (!ctx.isIdle() || ctx.hasPendingMessages()) continue;
		if (!underWay()) return overruled;
		overruled += 1;
	}
}

/** The command the request is handed to, and its argument for a reload. */
export const COMMAND = "harness";
export const RELOAD_ARG = "reload";

/** A `~/` path made absolute; anything else resolved against `cwd`. */
function expand(path: string, cwd: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return resolve(cwd, path);
}

/**
 * The tree a reload is to load, or undefined for the install.
 *
 * Left out, it is whatever runs now, so a tree being edited is loaded
 * again rather than dropped for the install. A null is left out too,
 * as is the `"null"` pi's schema coercion makes of one: seen live, a
 * model passing `onto: null` was refused for a checkout named null.
 */
export function treeToLoad(
	onto: string | null | undefined,
	running: Loaded,
	cwd: string,
	home: string,
): string | undefined {
	const given = onto?.trim();
	if (given === undefined || given === "" || given === "null") {
		return isSwapped(running) ? running.root : undefined;
	}
	if (given === INSTALLED) return undefined;
	const tree = canonical(expand(given, cwd, home));
	if (tree === running.install) return undefined;
	if (packageName(tree) !== PACKAGE_NAME) {
		throw new Error(
			`${homely(tree)} is not a checkout of ${PACKAGE_NAME}: its package.json names ${packageName(tree) ?? "nothing"}. Pass a worktree of this package, or "${INSTALLED}".`,
		);
	}
	return tree;
}

/**
 * Ask for a reload onto `tree` (or the install), once the run ends.
 * A tree is loaded in a pi of its own first, and a tree that does not
 * load is refused here, before anything touches the settings.
 */
export async function requestReload(
	reason: string,
	tree: string | undefined,
	settings: PackageSettings,
	onProgress: (text: string) => void,
): Promise<string> {
	const slot = reloadSlot();
	let checked = "";
	if (tree !== undefined) {
		if (entryFor(settings, settings.read(), PACKAGE_NAME) < 0) {
			throw new Error(
				`pi's settings name no package entry for ${PACKAGE_NAME}, so a reload cannot swap a tree in. Start pi with \`-e ${tree}\` instead.`,
			);
		}
		onProgress(`Checking that ${homely(tree)} loads`);
		const report = await checkLoad(getParentPiInstall(), tree);
		if (!report.ok) {
			throw new Error(
				`${describeLoad(report, homely(tree))}\nNothing was reloaded. Fix what failed and ask again, or reload onto "${INSTALLED}".`,
			);
		}
		checked = ` It loads in a pi of its own: ${report.commands} commands, no extension failed.`;
	}
	slot.request = { reason, by: "agent", ...(tree ? { tree } : {}) };
	slot.dispatched = false;
	const onto = tree ? ` onto ${homely(tree)}` : " onto the install";
	return [
		`Reload queued${onto}.${checked}`,
		"It runs as soon as this run ends, so end your turn now, without another call.",
		"When it lands, a message says which code runs and you carry on from there.",
		"Background jobs keep running through the reload, and their results arrive in the reloaded session.",
	].join(" ");
}

/** The request waiting for the run to end, taken for the command, or nothing. */
export function takeForDispatch(): ReloadRequest | undefined {
	const slot = reloadSlot();
	if (slot.request === undefined || slot.dispatched) return undefined;
	slot.dispatched = true;
	return slot.request;
}

/** Drop a waiting request, because the person stopped the run it was waiting on. */
export function callOff(): ReloadRequest | undefined {
	const slot = reloadSlot();
	const request = slot.request;
	if (request === undefined || slot.dispatched) return undefined;
	slot.request = undefined;
	return request;
}

/**
 * Reload, from a command's context. Runs the agent's request when one
 * is waiting, and otherwise the person's: onto whatever runs now.
 */
export async function performReload(
	ctx: ExtensionCommandContext,
	running: Loaded,
	settings: PackageSettings,
	run: {
		/** Whether a run has started since the last one settled. */
		underWay: () => boolean;
		/** Told when pi said still while a run was under way. */
		overruled: (times: number) => void;
	} = { underWay: () => false, overruled: () => {} },
): Promise<void> {
	const slot = reloadSlot();
	// One at a time. On 24 October the follower's command and the agent's
	// both ran: two reloads overlapped, and the runtime the first started
	// was replaced without going stale, its job host still first on the
	// bus, holding carried jobs and saying the landing every 30 seconds.
	if (slot.performing) return;
	slot.performing = true;
	try {
		await reloadOnce(ctx, running, settings, run);
	} finally {
		slot.performing = false;
	}
}

/** The reload {@link performReload} runs, once nothing else is. */
async function reloadOnce(
	ctx: ExtensionCommandContext,
	running: Loaded,
	settings: PackageSettings,
	run: {
		underWay: () => boolean;
		overruled: (times: number) => void;
	},
): Promise<void> {
	const slot = reloadSlot();
	const tree = isSwapped(running) ? running.root : undefined;
	// Set before the wait, so the new runtime knows this one will say
	// how it went and does not say it twice.
	slot.request ??= {
		reason: "you asked with /harness reload",
		by: "person",
		...(tree ? { tree } : {}),
	};
	const overruled = await untilStill(ctx, STILL_MS, run.underWay);
	if (overruled > 0) run.overruled(overruled);
	// Read after the wait: the session's own request says what came in,
	// and more can come in while it waits.
	const request: ReloadRequest = slot.request;
	let restore: Restore | undefined;
	if (request.tree !== undefined) {
		try {
			restore = await pointEntryAt(settings, PACKAGE_NAME, request.tree);
		} catch (error) {
			slot.request = undefined;
			slot.dispatched = false;
			ctx.ui.notify(
				`Did not reload: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	}
	slot.landed = undefined;
	slot.reloading = true;
	let restored: boolean | undefined;
	try {
		await ctx.reload();
	} finally {
		slot.reloading = false;
		if (restore) {
			try {
				restored = await restore();
			} catch {
				// Unwritten is as bad as changed: the settings may still name the tree.
				restored = false;
			}
		}
		// Left by the new runtime if it came up; this context is stale now,
		// so it is the only voice the reload has.
		const landed = reloadSlot().landed;
		slot.request = undefined;
		slot.dispatched = false;
		landed?.({ ...request, ...(restored === undefined ? {} : { restored }) });
	}
}
