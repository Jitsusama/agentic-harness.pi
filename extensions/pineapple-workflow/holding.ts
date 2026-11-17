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
 *
 * A host tends on every conversation's clock on its one thread, so the
 * claim and the notes, read or touched each minute, go through the
 * promise API, where a stalled disk holds only the tending. What is
 * written only when a hold changes (the hold, its note, the shadow
 * log) stays synchronous and whole. Since a host's conversations now
 * reach the claim between each other's awaits, a process tends a notes
 * folder once at a time, passing over a tending stuck past a claim's
 * stale spell as another session would its claim, and a claim is given
 * back only by the tending that wrote it.
 */

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	HOLD_SENDER,
	type Kept,
	tending,
} from "../../lib/internal/pineapple/hold.ts";
import type { Stop } from "../../lib/internal/pineapple/stops.ts";
import { processGlobal } from "../../lib/internal/process/process-global.ts";
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
	/** How a note is read off the thread, so a test can stall a tending. */
	readonly readNote?: (path: string) => Promise<string>;
}

/** How old a claim is before it is taken for a dead session's. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

const CLAIM = "claim";

/**
 * When this process began tending each notes folder, in every copy of
 * this module. The key names its shape, so a copy that kept another
 * shape would use its own.
 */
const TENDING = "agentic-harness.pineapple.tending.v1";

/** Send, renew and end holds, unless another session is doing so. */
export async function tendHolds(deps: HoldingDeps): Promise<void> {
	// Taken on the caller's turn, so no two of a host's conversations, nor
	// two ticks of one, are past this at once. One stuck past a claim's
	// stale spell is passed over, as its claim would be.
	const here = processGlobal(TENDING, () => new Map<string, number>());
	const began = here.get(deps.notes);
	if (began !== undefined && deps.now() - began < STALE_CLAIM_MS) return;
	const mine = deps.now();
	here.set(deps.notes, mine);
	try {
		await mkdir(deps.notes, { recursive: true });
		const token = await claim(deps);
		if (token !== undefined) await tendClaimed(deps, token);
	} finally {
		if (here.get(deps.notes) === mine) here.delete(deps.notes);
	}
}

async function tendClaimed(deps: HoldingDeps, token: string): Promise<void> {
	try {
		const kept = await keptNotes(
			deps.notes,
			deps.readNote ?? ((path) => readFile(path, "utf8")),
		);
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
		await release(join(deps.notes, CLAIM), token);
	}
}

/** The claim's token once this session holds it, else nothing. */
async function claim(deps: HoldingDeps): Promise<string | undefined> {
	const path = join(deps.notes, CLAIM);
	const token = `${deps.pid}:${randomUUID()}`;
	try {
		await writeFile(path, token, { flag: "wx" });
		return token;
	} catch {
		// Claimed: by a live session, which tends them now, or a dead one.
	}
	try {
		const fresh = deps.now() - (await stat(path)).mtimeMs < STALE_CLAIM_MS;
		if (fresh) return undefined;
		await rm(path, { force: true });
		await writeFile(path, token, { flag: "wx" });
		return token;
	} catch {
		// Another session took the stale claim first, or it just went.
		return undefined;
	}
}

/** Give the claim back, unless another session has taken it since. */
async function release(path: string, token: string): Promise<void> {
	const held = await readFile(path, "utf8").catch(() => {
		// Gone already, or unreadable: left, it goes stale on its own.
		return undefined;
	});
	// Another session takes it only once it is two minutes old, so only a
	// tending that ran longer, as on a stalled disk, leaves a gap between
	// this read and the removal; the next tending then sends again.
	if (held === token) await rm(path, { force: true });
}

async function keptNotes(
	notes: string,
	readNote: (path: string) => Promise<string>,
): Promise<Kept[]> {
	const kept: Kept[] = [];
	for (const name of await readdir(notes)) {
		if (!name.endsWith(".json")) continue;
		try {
			const note = JSON.parse(await readNote(join(notes, name))) as unknown;
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
