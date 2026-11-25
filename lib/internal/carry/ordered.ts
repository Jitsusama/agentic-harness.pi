/**
 * The harness's files in a carry an orchestrator orders, or a machine's
 * node chooses to ease it, as mycelium reads them (its PROTOCOL.md, A
 * Carry an Orchestrator Orders).
 *
 * A session the node steers `ordered-carry` may refuse, saying why, as
 * ISXEG8's condition 4 asks (15 November): it writes
 * `<session>.refused.json` in the handover folder its done file would go
 * in, holding only `session`, `why` and `at`, so mycelium fails fast
 * rather than waiting out its quarter hour, and counts it only when it
 * is no older than the order. Nothing of the steer is copied into it.
 *
 * A session carried that way is told on arrival who carried it and why,
 * as condition 3 asks, by a steer of its own from the machine's
 * pi-carry, never as the person: `pi-carry arrive --by --why` writes it
 * once the session's work is in place. A carry the node of the machine
 * it left chose is said as that node's, never as an orchestrator's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress, sessionAddress } from "../../mesh/address.ts";
import { giveSteer } from "../../mesh/steer.ts";
import { FROM_MACHINE, nodeMachine } from "../../mesh/steer-who.ts";
import { writeWhole } from "../write-whole.ts";

/** Where a session's refusal goes, beside where its done file would. */
export function refusedFileOf(handover: string, session: string): string {
	return join(handover, `${session}.refused.json`);
}

/** A session's refusal of an ordered carry. */
export interface Refusal {
	readonly session: string;
	readonly why: string;
	readonly at: Date;
}

/**
 * Writes a session's refusal whole into `handover`, answering its path;
 * one already there saying a later time stays, so a refusal landing late
 * never hides a later carry's. One saying a time ahead of `now`, as a
 * clock stepped back or a name dated ahead could leave, is replaced, so
 * it never hides every refusal after it.
 */
export function writeRefused(
	handover: string,
	refusal: Refusal,
	now: number = Date.now(),
): string {
	const file = refusedFileOf(handover, refusal.session);
	const was = refusedAt(file);
	if (was > refusal.at.getTime() && was <= now + AHEAD_MS) return file;
	writeWhole(
		file,
		`${JSON.stringify({
			session: refusal.session,
			why: refusal.why,
			at: refusal.at.toISOString(),
		})}\n`,
	);
	return file;
}

/**
 * How far ahead of now a refusal there may say and still stand: its own
 * stamp is the end of its steer's millisecond, so one written a moment
 * ago may be just ahead.
 */
const AHEAD_MS = 1000;

/** The time the refusal at `file` says, or NaN where none can be read. */
function refusedAt(file: string): number {
	try {
		const said: unknown = JSON.parse(readFileSync(file, "utf8"));
		const was =
			typeof said === "object" &&
			said !== null &&
			"at" in said &&
			typeof said.at === "string"
				? Date.parse(said.at)
				: Number.NaN;
		return was;
	} catch {
		// None there, or none to read: this one goes in.
		return Number.NaN;
	}
}

/** Who carried a session here, and why, as the node stamped it. */
export interface CarriedBy {
	readonly session: string;
	/** The machine it left. */
	readonly from: string;
	/**
	 * The orchestrator's address that ordered it, or `node@<from>` for a
	 * carry the node of the machine it left chose ([`carriedBy`]).
	 */
	readonly by: string;
	readonly why: string;
}

/**
 * Who an arrival from the machine `from` says carried it, as given
 * `by`: an orchestrator's address in capitals, or `node@<from>` as
 * written, since only the node of the machine a session left chose to
 * carry it; nothing otherwise.
 */
export function carriedBy(by: string, from: string): string | undefined {
	if (by.startsWith("node@")) {
		return nodeMachine(by) === from ? by : undefined;
	}
	return isAddress(by) ? by.toUpperCase() : undefined;
}

/** The program a machine steer names as its writer here. */
const PI_CARRY = "pi-carry";

/**
 * Tells the arriving session, through its own steer inbox under `root`,
 * who carried it and why, as the machine's pi-carry rather than the
 * person; answers the steer's file name.
 */
export function tellCarried(root: string, carried: CarriedBy): string {
	const node = nodeMachine(carried.by);
	const whose =
		node === undefined
			? `The person didn't carry it: ${carried.by}, the orchestrator above its quest, ordered it, and the mycelium node checked that it may.`
			: `The person didn't carry it, and no orchestrator ordered it: the mycelium node on ${node} chose to, on its own.`;
	return giveSteer(root, sessionAddress(carried.session), {
		text: `This session was carried here from ${carried.from} by ${carried.by}, for ${carried.why}. ${whose} Carry on where you left off.`,
		from: FROM_MACHINE,
		by: PI_CARRY,
		at: new Date().toISOString(),
	});
}
