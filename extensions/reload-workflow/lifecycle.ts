/**
 * What this runtime knows when it starts: which code it is, whether
 * that is the install, and how to say a reload landed.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	describeLoaded,
	homely,
	isSwapped,
	type Loaded,
	readLoaded,
} from "../../lib/internal/reload/loaded.ts";
import {
	installRoot,
	type PackageSettings,
	packageName,
} from "../../lib/internal/reload/settings.ts";
import {
	type ReloadLanded,
	reloadSlot,
} from "../../lib/internal/reload/slot.ts";
import { findJobHost } from "../../lib/jobs/index.ts";
import { footerMark } from "../../lib/ui/footer-mark.ts";

/** The package this extension was loaded from. */
export const PACKAGE_ROOT = canonical(
	fileURLToPath(new URL("../..", import.meta.url)),
);

/** The package's name, which is how its settings entry is recognised. */
export const PACKAGE_NAME = packageName(PACKAGE_ROOT) ?? "agentic-harness.pi";

/** The footer slot the mark sits in. */
export const STATUS_KEY = "reload";

/** The custom message a reload nobody asked the agent for is said in. */
export const LOADED_MESSAGE = "harness-loaded";

/** A path with symlinks resolved and no trailing slash, so two can be compared. */
export function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A path that is gone is compared as written.
		return resolve(path);
	}
}

/** What this runtime is running, read now. */
export async function whatRuns(settings: PackageSettings): Promise<Loaded> {
	let install: string | undefined;
	try {
		const root = installRoot(settings, PACKAGE_NAME);
		install = root === undefined ? undefined : canonical(root);
	} catch {
		// Settings pi cannot read name no install; the runtime still runs.
		install = undefined;
	}
	return readLoaded(PACKAGE_ROOT, install);
}

/** Show the mark while the session runs something other than the install. */
export function showMark(ctx: ExtensionContext, loaded: Loaded): void {
	try {
		ctx.ui.setStatus(
			STATUS_KEY,
			isSwapped(loaded)
				? footerMark("swapped", "muted", ctx.ui.theme)
				: undefined,
		);
	} catch {
		// A stale context after a reload has no footer to update.
	}
}

/** The sentence a landed reload is said in. */
export function landedText(landed: ReloadLanded, loaded: Loaded): string {
	const onto = landed.tree ? ` onto ${homely(landed.tree)}` : "";
	const lines = [
		landed.by === "self"
			? `Reloaded between runs, because the install moved: ${landed.reason}.`
			: `Reloaded${onto}, as asked: ${landed.reason}.`,
		describeLoaded(PACKAGE_NAME, loaded),
	];
	if (landed.restored === false) {
		lines.push(
			"pi's settings may still name the tree in place of the install: check `packages` in ~/.pi/agent/settings.json.",
		);
	}
	if (landed.by === "agent") lines.push("Carry on from where you were.");
	return lines.join(" ");
}

/**
 * Say that a reload landed. The agent asked, so the agent carries on:
 * that is a turn nobody typed, which only the job host starts. The
 * person asked, so the model is told quietly and the person, who did
 * it, is not told again. The session did it itself, so both are told,
 * and nothing carries on that was not already going to.
 */
export function sayLanded(
	pi: ExtensionAPI,
	landed: ReloadLanded,
	loaded: Loaded,
): void {
	const text = landedText(landed, loaded);
	const host = landed.by === "agent" ? findJobHost(pi.events) : undefined;
	if (host) {
		host
			.start({ kind: "reload", label: "the reload you asked for" })
			.finish({ summary: text });
		return;
	}
	// Nobody asked for a reload of its own, so the person is shown it
	// too; it never starts a turn.
	pi.sendMessage({
		customType: LOADED_MESSAGE,
		content: text,
		display: landed.by === "self",
	});
	// The reload took a compaction's moment, so it carries on the run
	// that compaction interrupted, as the compaction would have.
	if (landed.resume !== undefined) {
		pi.sendUserMessage(landed.resume, { deliverAs: "followUp" });
	}
}

/**
 * Start this runtime: show the mark, leave the way to say a reload
 * landed, and tell the model when the code changed under it without
 * anybody asking through the harness (pi's own `/reload`).
 *
 * During a reload onto a tree the settings name the tree, so what this
 * runtime reads at start says it runs the install. It reads again once
 * the reload has landed and the settings are back, and `onLoaded`
 * hears each reading.
 */
export async function startRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: string,
	settings: PackageSettings,
	onLoaded: (loaded: Loaded) => void,
): Promise<void> {
	const slot = reloadSlot();
	// Asked for before anything is awaited, so the request is read as it
	// stood when this runtime started, and the way to say a reload landed
	// is in place however long git takes to answer.
	const askedThroughHarness = slot.reloading === true;
	if (!askedThroughHarness) {
		// Whatever started this runtime, it was not the request: that
		// belonged to the code before, and asking again would reload twice.
		slot.request = undefined;
		slot.dispatched = false;
	}
	slot.landed = (landed) => {
		void whatRuns(settings).then((loaded) => {
			onLoaded(loaded);
			showMark(ctx, loaded);
			sayLanded(pi, landed, loaded);
		});
	};
	const loaded = await whatRuns(settings);
	onLoaded(loaded);
	showMark(ctx, loaded);
	if (reason === "reload" && !askedThroughHarness) {
		pi.sendMessage({
			customType: LOADED_MESSAGE,
			content: `The harness was reloaded. ${describeLoaded(PACKAGE_NAME, loaded)}`,
			display: false,
		});
	}
}
