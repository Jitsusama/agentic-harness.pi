/**
 * Holding or waking another cell from a session, as the launcher's hold
 * and wake do, through the node's steer: a `pause` or `resume` put in
 * that cell's inbox on whichever machine runs it, which wakes it too
 * where it is parked on this machine (Joel, 24 November: "any interface
 * i'm in should be directly engagable to a meaningful level").
 *
 * Each steer is signed by the session sending it, never as the person:
 * the node refuses a person's word from an agent's process, and a
 * session's window runs as one, so it says honestly who asks. KP0L6A
 * agreed that shape on 24 November until a typed command can prove the
 * person typed it.
 */

import { isRecord } from "../internal/record.ts";
import { askAt, NODE_PATIENCE_MS } from "./node.ts";

/** What a cell may be asked to do from another session. */
export type CellAct = "hold" | "wake";

/** The steer's own act for each. */
const STEER_ACT: Record<CellAct, "pause" | "resume"> = {
	hold: "pause",
	wake: "resume",
};

/** How long the node may take to answer a steer, which may cross a link. */
const STEER_PATIENCE_MS = 10 * NODE_PATIENCE_MS;

/** What steering a cell came to: the machine told, or why not. */
export type Steered =
	| { readonly ok: true; readonly machine: string }
	| { readonly ok: false; readonly reason: string };

/** Ask the node one request, answering its line or nothing. */
export type Ask = (
	socket: string | undefined,
	request: unknown,
	patience: number,
) => Promise<string | undefined>;

/** The steer that asks cell `act` of a cell, signed `from`. */
export function cellSteer(
	act: CellAct,
	from: string,
	now: Date = new Date(),
): Record<string, string> {
	return { act: STEER_ACT[act], from, at: now.toISOString() };
}

/**
 * Ask the cell going by `address` to `act`, signed `from`, through the
 * node at `socket`: answers the machine told, or the node's reason.
 */
export async function steerCell(
	socket: string | undefined,
	address: string,
	act: CellAct,
	from: string,
	ask: Ask = askAt,
): Promise<Steered> {
	if (!/^[A-Za-z0-9]{1,16}$/u.test(address)) {
		return { ok: false, reason: `${address} isn't a cell's address` };
	}
	if (address.toUpperCase() === from.toUpperCase()) {
		return {
			ok: false,
			reason: `${address} is this session: it can't ${act} itself from here`,
		};
	}
	const line = await ask(
		socket,
		{ Steer: { address, steer: cellSteer(act, from) } },
		STEER_PATIENCE_MS,
	);
	if (line === undefined) {
		return {
			ok: false,
			reason:
				socket === undefined
					? "no mycelium node runs here to steer it through"
					: `the node answered nothing within ${STEER_PATIENCE_MS / 1000} s, so ${address} may or may not have been told`,
		};
	}
	return steeredFrom(line);
}

/** A steer's answer read: the machine told, or the node's reason. */
export function steeredFrom(line: string): Steered {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Fall through to the answer this reader can't read.
	}
	if (isRecord(reply) && typeof reply.Err === "string") {
		return { ok: false, reason: reply.Err };
	}
	const steered =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Steered : undefined;
	if (isRecord(steered) && typeof steered.machine === "string") {
		return { ok: true, machine: steered.machine };
	}
	return {
		ok: false,
		reason: `the node answered what this harness can't read: ${line.slice(0, 200)}`,
	};
}
