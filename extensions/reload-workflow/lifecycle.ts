/**
 * What this runtime knows when it starts: which code it is, whether
 * that is the install, and how to say a reload landed.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CustomMessageEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/index.ts";
import { takeOwedTurn } from "../../lib/internal/reload/hold.ts";
import {
	describeLoaded,
	homely,
	isSwapped,
	LOADED_MESSAGE,
	type Loaded,
	readLoaded,
} from "../../lib/internal/reload/loaded.ts";
import {
	sayLoaded,
	sayLoadedIn,
	unsayLoaded,
} from "../../lib/internal/reload/said.ts";
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
import { takeHostedLanding } from "./hosted.ts";

/** The package this extension was loaded from. */
export const PACKAGE_ROOT = canonical(
	fileURLToPath(new URL("../..", import.meta.url)),
);

/** The package's name, which is how its settings entry is recognised. */
export const PACKAGE_NAME = packageName(PACKAGE_ROOT) ?? "agentic-harness.pi";

/** The footer slot the mark sits in. */
export const STATUS_KEY = "reload";

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

/** Where this process keeps the file it said what it loaded in. */
const SAID_FILE = Symbol.for("agentic-harness.reload.said-file");

/**
 * Tell pi-packages which code this pi runs, so it removes a version once
 * no pi runs it (lib/internal/reload/said.ts), and take it back as the
 * process ends. Each load says it again; the process's one file is taken
 * back once, whichever load wrote it last.
 *
 * In a host each conversation's load says it, so the version its
 * conversations run is never swept under them, but none takes it back:
 * one conversation ending must not do so for the others, and the host's
 * process adds no exit listener for it. pi-packages counts a file only
 * while its pid runs and removes it once the process has ended
 * (core.nix's pi-packages, src/loaded.rs).
 */
export function tellPiPackages(settings: PackageSettings): void {
	let install: string | undefined;
	try {
		install = installRoot(settings, PACKAGE_NAME);
	} catch {
		// Settings pi cannot read name no install; a version still says so.
		install = undefined;
	}
	const said: unknown = Reflect.get(globalThis, SAID_FILE);
	// Onto a tree, the settings name the tree too, so no install folder can
	// be found: the file this process said in before is still the one.
	const file =
		sayLoaded(PACKAGE_ROOT, install) ??
		(typeof said === "string" ? sayLoadedIn(said, PACKAGE_ROOT) : undefined);
	if (file === undefined || said === file) return;
	Reflect.set(globalThis, SAID_FILE, file);
	if (!hosted()) process.once("exit", () => unsayLoaded(file));
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

/**
 * What to tell the model when the session's last note on which code
 * runs no longer holds, or undefined when it does or there is none.
 * `now` is what runs, as describeLoaded says it, which every note
 * holds. A pi started afresh on a session (woken, restarted, reopened)
 * loads whatever is installed then, and says nothing of it unless
 * asked: on 13 November a session woken at 19:06 ran the install of
 * 18:37 while its last note named the code of 17:26, and its model
 * went by the note.
 */
export function outdatedNoteSaid(
	entries: readonly SessionEntry[],
	now: string,
): string | undefined {
	const last = [...entries]
		.reverse()
		.find(
			(entry): entry is CustomMessageEntry =>
				entry.type === "custom_message" && entry.customType === LOADED_MESSAGE,
		);
	if (last === undefined) return undefined;
	const text =
		typeof last.content === "string"
			? last.content
			: last.content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("");
	if (text.includes(now)) return undefined;
	return `This pi started afresh since the last note on which harness code runs, so that note and the ones before it are out of date. ${now}`;
}

/** Tell the model when the session's last note on what runs is out of date. */
function sayIfOutdated(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	loaded: Loaded,
): void {
	let entries: readonly SessionEntry[];
	try {
		entries = ctx.sessionManager.getBranch();
	} catch {
		// A context with no session behind it has no notes to correct.
		return;
	}
	const said = outdatedNoteSaid(entries, describeLoaded(PACKAGE_NAME, loaded));
	if (said === undefined) return;
	// It never starts a turn, and never fills the person's screen.
	pi.sendMessage({ customType: LOADED_MESSAGE, content: said, display: false });
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
 * it, is not told again. The session did it itself, and the model is
 * told quietly too: shown to the person, one notice per install filled
 * idle sessions until Joel could not see what each was for (8 a session
 * in under an hour on 22 October), and the status bar already says
 * which code runs. Nothing carries on that was not already going to,
 * but a turn a delivery put off so the reload could go first starts
 * here, whoever asked (hold.ts).
 */
export function sayLanded(
	pi: ExtensionAPI,
	landed: ReloadLanded,
	loaded: Loaded,
): void {
	const owed = takeOwedTurn();
	const said = landedText(landed, loaded);
	const text =
		owed && landed.by !== "agent"
			? `${said} Act on what reached you while it waited.`
			: said;
	const host =
		owed || landed.by === "agent" ? findJobHost(pi.events) : undefined;
	if (host) {
		host
			.start({ kind: "reload", label: "the reload you asked for" })
			.finish({ summary: text });
		return;
	}
	// It never starts a turn, and never fills the person's screen.
	pi.sendMessage({
		customType: LOADED_MESSAGE,
		content: text,
		display: false,
	});
}

/**
 * Start a hosted conversation's runtime. Its landing waits in its own
 * slot (hosted.ts) rather than the process's reload slot, whose speaker
 * and request every conversation in the host would share.
 */
async function startHostedRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: string,
	settings: PackageSettings,
	onLoaded: (loaded: Loaded) => void,
): Promise<void> {
	const landed = reason === "reload" ? takeHostedLanding(ctx) : undefined;
	const loaded = await whatRuns(settings);
	onLoaded(loaded);
	showMark(ctx, loaded);
	if (landed) {
		sayLanded(pi, landed, loaded);
		return;
	}
	if (reason === "reload") {
		pi.sendMessage({
			customType: LOADED_MESSAGE,
			content: `The harness was reloaded. ${describeLoaded(PACKAGE_NAME, loaded)}`,
			display: false,
		});
		return;
	}
	sayIfOutdated(pi, ctx, loaded);
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
	if (hosted()) return startHostedRuntime(pi, ctx, reason, settings, onLoaded);
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
	// Git can take seconds to say what runs, and the session can be
	// replaced meanwhile: on 22 October a rollover switched the session
	// four seconds into that wait, the captured pi went stale, and the
	// throw escaped this promise and took pi down. So a runtime that is no
	// longer the newest hands the landing on, and one that cannot speak
	// leaves it for the next to start. Nothing here may throw.
	const speak = (landed: ReloadLanded): void => {
		void whatRuns(settings)
			.then((loaded) => {
				const newest = reloadSlot().landed;
				if (newest !== speak) {
					if (newest) newest(landed);
					else reloadSlot().unsaid = landed;
					return;
				}
				onLoaded(loaded);
				showMark(ctx, loaded);
				sayLanded(pi, landed, loaded);
			})
			.catch(() => {
				reloadSlot().unsaid = landed;
			});
	};
	slot.landed = speak;
	const loaded = await whatRuns(settings);
	onLoaded(loaded);
	showMark(ctx, loaded);
	// A landing the runtime before this one could not say.
	const unsaid = slot.unsaid;
	if (unsaid !== undefined) {
		slot.unsaid = undefined;
		sayLanded(pi, unsaid, loaded);
		return;
	}
	if (reason === "reload" && !askedThroughHarness) {
		pi.sendMessage({
			customType: LOADED_MESSAGE,
			content: `The harness was reloaded. ${describeLoaded(PACKAGE_NAME, loaded)}`,
			display: false,
		});
		return;
	}
	// A reload the harness asked for says its landing once it lands.
	if (reason !== "reload") sayIfOutdated(pi, ctx, loaded);
}
