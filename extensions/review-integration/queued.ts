/**
 * Changes this session sent to a merge queue, said landed once they merge.
 *
 * A change merged when asked is said landed at once (offer.ts). One sent to
 * a queue, as every World change is, by a `/merge` comment or a merge the
 * backend answers as enqueued, merges minutes or hours later, after its
 * batch's checks. Nothing said those: on 8 November the landings record
 * held 320 changes and not one of World's, though one World quest alone had
 * put up 32 (80ECO2 [a624bb26]), so tokens per landing couldn't be measured
 * for most of the spend.
 *
 * So each one is noted here, in a file of this session's that a reload
 * keeps, and looked at every few minutes. Once it shows merged it is said
 * landed as a direct merge is, by this session, whose presence carries its
 * quest into the record; once it shows closed it is said closed, so a look
 * at it stops waiting. One still queued after a week is let go.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Change, ChangeRef } from "../../lib/core/review/index.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import { sayClosed, sayLanded } from "../../lib/internal/session/landings.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { reviewEngine, sessionKey } from "./engine.ts";

/** A comment that sends a change to World's merge queue. */
export const MERGE_COMMAND = /^\s*\/merge\s*$/;

/** How often the queued changes are looked at. */
export const QUEUED_LOOK_MS = 5 * 60_000;

/** How long a change may sit queued before it is let go. */
export const QUEUED_FOR_MS = 7 * 24 * 60 * 60_000;

/** A change sent to a queue, and the line its merge carries. */
export interface Queued {
	readonly change: ChangeRef;
	/** When it was sent, as an ISO time. */
	readonly since: string;
	/** What it means to the session's person, when the merge said. */
	readonly person?: string;
}

/** What a look at a queued change finds of it. */
export type Seen = Pick<Change, "state" | "title" | "url"> | null;

/** Where this session keeps what it queued. */
function queuedFile(session = sessionKey()): string {
	const name = session.replace(/[^A-Za-z0-9-]/g, "_");
	return join(stateDir("review"), "queued", `${name}.json`);
}

function isQueued(value: unknown): value is Queued {
	if (typeof value !== "object" || value === null) return false;
	const { change, since } = value as Record<string, unknown>;
	return (
		typeof since === "string" &&
		typeof change === "object" &&
		change !== null &&
		typeof (change as Record<string, unknown>).label === "string"
	);
}

/** What this session has queued and not yet seen land. */
export function queuedHere(): Queued[] {
	try {
		const read: unknown = JSON.parse(readFileSync(queuedFile(), "utf8"));
		return Array.isArray(read) ? read.filter(isQueued) : [];
	} catch {
		// Nothing queued yet, or a file a crash cut short: nothing to watch.
		return [];
	}
}

function keep(list: readonly Queued[]): void {
	const file = queuedFile();
	if (list.length === 0) rmSync(file, { force: true });
	else writeWhole(file, JSON.stringify(list));
}

/** Note a change sent to a queue, so it is said landed once it merges. */
export function noteQueued(
	change: ChangeRef,
	person?: string,
	now: number = Date.now(),
): void {
	const others = queuedHere().filter(
		(one) => one.change.label !== change.label,
	);
	keep([
		...others,
		{
			change,
			since: new Date(now).toISOString(),
			...(person ? { person } : {}),
		},
	]);
}

/**
 * Look at each queued change once: say landed what merged and closed what
 * closed, let go what has waited past {@link QUEUED_FOR_MS}, and keep the
 * rest. A change that can't be read now is kept for the next look.
 */
export async function settleQueued(
	read: (change: ChangeRef) => Promise<Seen>,
	bus: Pick<EventBus, "emit">,
	now: number = Date.now(),
): Promise<void> {
	const done = new Set<string>();
	for (const one of queuedHere()) {
		let seen: Seen;
		try {
			seen = await read(one.change);
		} catch {
			// The host didn't answer: look again next time.
			continue;
		}
		const label = one.change.label;
		if (seen?.state === "merged") {
			sayLanded(bus, {
				ref: label.slice(label.lastIndexOf("/") + 1),
				what: seen.title || `${label} merged`,
				...(seen.url ? { url: seen.url } : {}),
				...(one.person ? { person: one.person } : {}),
			});
			done.add(label);
		} else if (seen?.state === "closed") {
			if (seen.url) sayClosed(bus, seen.url);
			done.add(label);
		} else if (now - Date.parse(one.since) > QUEUED_FOR_MS) {
			done.add(label);
		}
	}
	// Read again, so a change queued while these were looked at stays.
	if (done.size > 0) {
		keep(queuedHere().filter((one) => !done.has(one.change.label)));
	}
}

/**
 * Look at this session's queued changes every {@link QUEUED_LOOK_MS}
 * until it shuts down, so a reload's new copy is the only one looking.
 */
export function watchQueued(pi: ExtensionAPI): void {
	let looking = false;
	const timer = setInterval(() => {
		if (looking || queuedHere().length === 0) return;
		looking = true;
		const read = async (change: ChangeRef): Promise<Seen> => {
			const { engine } = await reviewEngine(pi);
			return (await engine.bound(change)).proposal();
		};
		settleQueued(read, pi.events)
			.catch(() => {
				// A look that fails is made again next time.
			})
			.finally(() => {
				looking = false;
			});
	}, QUEUED_LOOK_MS);
	timer.unref();
	pi.on("session_shutdown", () => clearInterval(timer));
}
