/**
 * Machine holds crossing into the machine's other realms.
 *
 * A machine in two realms runs a mesh for each, kept apart completely,
 * so nothing a work session says reaches a personal one. But a switch, a
 * reboot or a nix-daemon restart takes the whole machine, and a personal
 * session mid-build is lost to it like any other (P9R1KI, 29 October,
 * on Joel's word that a machine may join both realms). So a hold sent to
 * the machine's group is written into each other realm's mesh too, as a
 * hold of a fixed form carrying none of the sender's words: no work's
 * text crosses, only that the machine is held, and when that ends.
 *
 * The mirror is sent from {@link MACHINE_SENDER} and replaced by a
 * fixed end from the same sender once the hold it mirrors is answered
 * or replaced by its holder, or ended on the person's word; a mirror
 * nobody ends lapses as every hold does. Which mirror stands for which
 * hold is kept beside this realm's mesh, one file per hold.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL } from "./group.ts";
import type { Message } from "./message.ts";
import type { Transport } from "./transport.ts";

/** The address a crossing hold is sent from in the realm it reaches. */
export const MACHINE_SENDER = "MACHINE";

/** The whole of a crossing hold's words. */
export const CROSSING_HOLD_TEXT =
	"A session in another realm on this machine is holding switches, reboots and nix-daemon restarts, as before one of them. Hold them too, and park work a restart would lose, until this hold ends.";

/** The whole of the words that end one. */
export const CROSSING_END_TEXT =
	"The other realm's hold on this machine is over: switches, reboots and nix-daemon restarts may go again.";

/** The other realms' meshes on this machine, and where this one keeps its notes. */
export interface Crossings {
	/** Each other realm's message transport, by the folder it keeps. */
	readonly others: () => readonly OtherRealm[];
	/** This realm's folder for which mirror stands for which hold. */
	readonly notes: string;
	/** The process sending, as every message names one. */
	readonly pid: number;
}

/** Another realm's mesh on this machine. */
export interface OtherRealm {
	/** Its mesh's folder, which names it across a restart. */
	readonly dir: string;
	readonly transport: Transport;
}

/** One hold's mirrors, each by the folder of the realm it went to. */
interface Noted {
	readonly mirrors: readonly { readonly dir: string; readonly id: string }[];
}

function isNoted(value: unknown): value is Noted {
	if (typeof value !== "object" || value === null) return false;
	const { mirrors } = value as { mirrors?: unknown };
	return (
		Array.isArray(mirrors) &&
		mirrors.every(
			(one) =>
				typeof one === "object" &&
				one !== null &&
				typeof (one as { dir?: unknown }).dir === "string" &&
				typeof (one as { id?: unknown }).id === "string",
		)
	);
}

const isHoldForTheMachine = (message: Message) =>
	message.intent === "hold" && message.to.includes(ALL);

/**
 * Carry what this peer just sent across, if it is a machine hold or ends
 * one: mirror a new hold into each other realm, or end the mirrors of
 * the hold it answers, replaces or ends on the person's word. Anything
 * else crosses nothing.
 */
export function cross(
	message: Message,
	crossings: Crossings,
	read: (id: string) => Message | undefined,
): void {
	for (const ended of [message.re, message.supersedes]) {
		if (ended === undefined) continue;
		const hold = read(ended);
		if (hold === undefined || !isHoldForTheMachine(hold)) continue;
		// Its holder ends it by answering or replacing it; anyone else only
		// on the person's word.
		const byHolder = hold.from === message.from || hold.pid === message.pid;
		if (!byHolder && !message.endsHold) continue;
		// A hold replaced by another machine hold still holds, and the new
		// one crosses in its own right below.
		endMirrors(ended, crossings);
	}
	if (isHoldForTheMachine(message)) mirror(message, crossings);
}

function mirror(hold: Message, crossings: Crossings): void {
	const mirrors = crossings.others().map(({ dir, transport }) => ({
		dir,
		id: transport.send({
			from: MACHINE_SENDER,
			to: [ALL],
			intent: "hold",
			text: CROSSING_HOLD_TEXT,
			pid: crossings.pid,
		}).id,
	}));
	if (mirrors.length === 0) return;
	mkdirSync(crossings.notes, { recursive: true });
	writeFileSync(
		noteOf(crossings, hold.id),
		`${JSON.stringify({ mirrors } satisfies Noted)}\n`,
	);
}

function endMirrors(holdId: string, crossings: Crossings): void {
	const path = noteOf(crossings, holdId);
	let noted: unknown;
	try {
		noted = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Never crossed, or already ended.
		return;
	}
	if (!isNoted(noted)) return;
	const others = crossings.others();
	for (const { dir, id } of noted.mirrors) {
		others
			.find((other) => other.dir === dir)
			?.transport.send({
				from: MACHINE_SENDER,
				to: [ALL],
				intent: "fyi",
				text: CROSSING_END_TEXT,
				pid: crossings.pid,
				supersedes: id,
			});
	}
	rmSync(path, { force: true });
}

const noteOf = (crossings: Crossings, holdId: string) =>
	join(crossings.notes, `${holdId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
