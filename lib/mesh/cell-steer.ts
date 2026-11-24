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
import { CELL_ADDRESS } from "./cell-link.ts";
import { type Heard, hearAt, NODE_PATIENCE_MS } from "./node.ts";

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

/** Ask the node one request, hearing its line, its silence or no node. */
export type Hear = (
	socket: string | undefined,
	request: unknown,
	patience: number,
) => Promise<Heard>;

/**
 * Who steers: the address its steer is signed by, and every address the
 * session goes by, its own cell's among them, none of which it may steer.
 */
export interface Signer {
	readonly from: string;
	readonly own: readonly string[];
}

/** The steer that asks cell `act` of a cell, signed `from`. */
export function cellSteer(
	act: CellAct,
	from: string,
	now: Date = new Date(),
): Record<string, string> {
	return { act: STEER_ACT[act], from, at: now.toISOString() };
}

/**
 * Ask the cell going by `address` to `act`, signed by `signer`, through
 * the node at `socket`: answers the machine told, or the node's reason.
 */
export async function steerCell(
	socket: string | undefined,
	address: string,
	act: CellAct,
	signer: Signer,
	hear: Hear = hearAt,
): Promise<Steered> {
	if (!CELL_ADDRESS.test(address)) {
		return { ok: false, reason: `${address} isn't a cell's address` };
	}
	const typed = address.toUpperCase();
	if ([signer.from, ...signer.own].some((own) => own.toUpperCase() === typed)) {
		return {
			ok: false,
			reason: `${address} is this session: it can't ${act} itself from here`,
		};
	}
	const heard = await hear(
		socket,
		{ Steer: { address, steer: cellSteer(act, signer.from) } },
		STEER_PATIENCE_MS,
	);
	if (heard.kind === "unreached") {
		return {
			ok: false,
			reason:
				socket === undefined
					? "no mycelium node runs here to steer it through"
					: `no mycelium node answered at ${socket}, so nothing was sent`,
		};
	}
	if (heard.kind === "silent") {
		return {
			ok: false,
			reason: heard.hungUp
				? `the node took the steer and hung up before it answered, so ${address} may or may not have been told`
				: `the node answered nothing within ${STEER_PATIENCE_MS / 1000} s, so ${address} may or may not have been told`,
		};
	}
	return steeredFrom(heard.line);
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
