/**
 * Sending, renewing and ending the mesh holds stops make, from whichever
 * session gets there first.
 *
 * Every session tends the holds on its clock, so they go out while any
 * session runs and stop going out when none does, and a hold left
 * behind lapses at its two hours on its own. One session tends at a
 * time, by a claim file beside the notes it keeps of each hold sent; a
 * claim left by a session that died is taken back after a few minutes.
 *
 * A stop still in shadow sends nothing: its would-be hold is written to
 * a log for Joel to read, once each renewal, and a note kept so the next
 * session doesn't write it again.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	HOLD_SENDER,
	type Kept,
	tending,
} from "../../lib/internal/pineapple/hold.ts";
import type { Stop } from "../../lib/internal/pineapple/stops.ts";
import type { Draft, Message } from "../../lib/mesh/message.ts";
import { writeAtomically } from "../../lib/mesh/transport.ts";

/** What tending the holds needs. */
export interface HoldingDeps {
	readonly stops: () => readonly Stop[];
	/** Where the notes and the claim are kept. */
	readonly notes: string;
	/** Sends on the realm's mesh. */
	readonly send: (draft: Draft) => Pick<Message, "id">;
	/** Where a shadow stop's would-be hold is written. */
	readonly shadowLog: string;
	readonly realm: string | undefined;
	readonly chainOf: (quest: string) => readonly string[];
	readonly pid: number;
	readonly now: () => number;
}

/** How old a claim is before it is taken for a dead session's. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

const CLAIM = "claim";

/** Send, renew and end holds, unless another session is doing so. */
export function tendHolds(deps: HoldingDeps): void {
	mkdirSync(deps.notes, { recursive: true });
	if (!claim(deps)) return;
	try {
		const kept = keptNotes(deps.notes);
		const now = deps.now();
		for (const step of tending(
			deps.stops(),
			kept,
			now,
			deps.realm,
			deps.chainOf,
		)) {
			if (step.kind === "end") {
				if (step.kept.hold !== "")
					deps.send({
						from: HOLD_SENDER,
						to: step.kept.to,
						intent: "fyi",
						text: step.text,
						pid: deps.pid,
						supersedes: step.kept.hold,
					});
				rmSync(join(deps.notes, noteName(step.kept.stop)), { force: true });
				continue;
			}
			let hold = "";
			if (step.stop.shadow) {
				writeFileSync(
					deps.shadowLog,
					`${JSON.stringify({ at: new Date(now).toISOString(), stop: step.stop.id, to: step.to, text: step.text })}\n`,
					{ flag: "a" },
				);
			} else {
				hold = deps.send({
					from: HOLD_SENDER,
					to: step.to,
					intent: "hold",
					text: step.text,
					pid: deps.pid,
					...(step.supersedes ? { supersedes: step.supersedes } : {}),
				}).id;
			}
			const note: Kept = {
				stop: step.stop.id,
				hold,
				to: step.to,
				at: now,
				shadow: step.stop.shadow,
			};
			writeAtomically(
				deps.notes,
				noteName(step.stop.id),
				`${JSON.stringify(note)}\n`,
			);
		}
	} finally {
		rmSync(join(deps.notes, CLAIM), { force: true });
	}
}

function claim(deps: HoldingDeps): boolean {
	const path = join(deps.notes, CLAIM);
	try {
		writeFileSync(path, String(deps.pid), { flag: "wx" });
		return true;
	} catch {
		// Claimed: by a live session, which tends them now, or a dead one.
	}
	try {
		if (deps.now() - statSync(path).mtimeMs < STALE_CLAIM_MS) return false;
		rmSync(path, { force: true });
		writeFileSync(path, String(deps.pid), { flag: "wx" });
		return true;
	} catch {
		// Another session took the stale claim first, or it just went.
		return false;
	}
}

function keptNotes(notes: string): Kept[] {
	const kept: Kept[] = [];
	for (const name of readdirSync(notes)) {
		if (!name.endsWith(".json")) continue;
		try {
			const note = JSON.parse(
				readFileSync(join(notes, name), "utf8"),
			) as unknown;
			if (isKept(note)) kept.push(note);
		} catch {
			// Half written or gone: the next tending writes it again.
		}
	}
	return kept;
}

function isKept(value: unknown): value is Kept {
	if (typeof value !== "object" || value === null) return false;
	const note = value as Record<string, unknown>;
	return (
		typeof note.stop === "string" &&
		typeof note.hold === "string" &&
		Array.isArray(note.to) &&
		note.to.every((one) => typeof one === "string") &&
		typeof note.at === "number" &&
		typeof note.shadow === "boolean"
	);
}

function noteName(stop: string): string {
	return `${stop.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}
