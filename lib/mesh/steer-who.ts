/**
 * Who a steer says it comes from: the person, the machine, an
 * orchestrator that ordered a carry, or this machine's node that chose
 * one, and this machine's name as its record says, read only for a
 * node's carry. Split from steer.ts, which reads and takes the inbox,
 * since what a carry's `by` may name changes for its own reasons
 * (ISXEG8's conditions, 15 November).
 */

import { homedir } from "node:os";
import { withinHome } from "../internal/carry/handover.ts";
import {
	isMachineName,
	machineRecordOf,
	thisMachineOff,
	thisMachineRead,
} from "../internal/machine/machine.ts";

/**
 * The `from` a machine's mycelium node writes, for what the machine itself
 * must say to a session it holds, as that it leaves at a set time. It is
 * never the person's word, so it carries no act.
 */
export const FROM_MACHINE = "machine";

/**
 * The act a carry an orchestrator ordered or this machine's node chose
 * is written with, apart from STEER_ACTS.
 */
export const ORDERED_CARRY = "ordered-carry";

/** A peer's address, a quest's six or a session's eight, as `by` names one. */
const ADDRESS = /^[A-Za-z0-9]{6,8}$/;

/**
 * Whether `by` can be a peer's address, in any letters: the one rule
 * for an orchestrator's name, here and where a carried session arrives.
 * The person's and the machine's own names fit an address's shape, so
 * each is refused by name, in any letters.
 */
export function isAddress(by: string): boolean {
	const lower = by.toLowerCase();
	return ADDRESS.test(by) && lower !== FROM_PERSON && lower !== FROM_MACHINE;
}

/** A node's own name as `by`, its machine's after the `@`. */
const NODE = /^node@(.*)$/;

/**
 * The machine whose node `by` names, as written, or nothing when `by`
 * names no node's.
 */
export function nodeMachine(by: string): string | undefined {
	const machine = NODE.exec(by)?.[1];
	return isMachineName(machine) ? machine : undefined;
}

/** The most an ordered carry's `why` says, so it reads as a reason. */
const MOST_WHY = 500;

/**
 * A carry an orchestrator ordered, or a machine's node chose to ease
 * it, as the node stamped it.
 */
export interface OrderedCarry {
	/** The machine it goes to, as it names itself. */
	readonly to: string;
	/** Why, in the words of whoever ordered or chose it. */
	readonly why: string;
	/**
	 * Who the steer claims carries it: the address of an orchestrator that
	 * ordered it, or `node@<machine>` for a carry this machine's node chose.
	 * Anything running as the person that reaches the inbox can write
	 * either, so it says whom the steer claims, never who wrote it.
	 */
	readonly by: string;
	/**
	 * Why the session refuses it as soon as it is taken, where taking it
	 * already tells: a carry another machine's node names, which no node
	 * here began, or a node's carry taken while this machine's record of
	 * its name can't be read, which may be either. Its refusal is said on
	 * screen and written nowhere, since this machine's node reads its
	 * handover and could take one written there as a carry's of its own:
	 * a record read again by then would name this machine's handover
	 * whoever's carry it was.
	 */
	readonly refused?: string;
	/**
	 * When its steer was put in the inbox, by the millisecond its name
	 * opens with, on this machine's clock: after its node began the carry,
	 * so a refusal stamped with it is never a later carry's.
	 */
	readonly put?: Date;
}

/**
 * Why a node's carry is refused while this machine's record is there but
 * `error` came of reading it: the file and the error's code, so one
 * that lasts can be found and put right.
 */
function unreadHere(error: unknown): string {
	return `${machineRecordUnread(error)}, so whose node's carry it is can't be told`;
}

/**
 * What came of reading this machine's record of its name, when `error`
 * did: the file, said from home since another machine may read it, and
 * the error's code, or that it names no machine.
 */
export function machineRecordUnread(error: unknown): string {
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: "an error";
	// Said from home, since it goes in a handover another machine reads.
	const record = withinHome(machineRecordOf(), homedir());
	const said =
		code === "it names no machine"
			? "names no machine"
			: `can't be read (${code})`;
	return `this machine's record of its name, ${record}, ${said}`;
}

/**
 * The `from` mycelium's node writes for what the person asked through it,
 * as `mycelium carry` steers each session with.
 */
export const FROM_PERSON = "person";

/**
 * Whether a steer's writer is the person: one who names nobody, Joel, or
 * the node writing on the person's word.
 */
export function isFromPerson(from: string | undefined): boolean {
	if (from === undefined || from === "") return true;
	const who = from.toLowerCase();
	return who === "joel" || who === FROM_PERSON;
}

/**
 * The ordered carry a steer holds, or nothing unless it is whole and
 * from an orchestrator or `here`'s node: `from` and `by` one address,
 * or both `node@<here>` as written, never the person or the machine, a
 * machine's name to go to, and a reason. With no `here`, a node's carry
 * is none.
 */
export function orderedFrom(
	parsed: object,
	from: string,
	here: string | undefined,
): OrderedCarry | undefined {
	if (!("act" in parsed) || parsed.act !== ORDERED_CARRY) return undefined;
	const to = "to" in parsed ? parsed.to : undefined;
	const why =
		"why" in parsed && typeof parsed.why === "string" ? parsed.why.trim() : "";
	if (!isMachineName(to) || why === "" || why.length > MOST_WHY) {
		return undefined;
	}
	// Last, since a node's name sends it to this machine's record.
	const by = orderedBy("by" in parsed ? parsed.by : undefined, from, here);
	return by === undefined ? undefined : { to, why, by };
}

/**
 * Who a steer from `from` says carries it: the address of an
 * orchestrator that ordered it, in capitals, from that address in any
 * letters, or `here`'s node, which chose it, as `node@<here>`, as
 * written, from exactly that; nothing
 * otherwise. Only this machine's node runs its sessions, so no other
 * node's name is taken, and none at all where `here` isn't given: the
 * inbox's readers read this machine's record, off the thread where they
 * are, only for a node's carry, so no other steer waits on a file.
 */
function orderedBy(
	by: unknown,
	from: string,
	here: string | undefined,
): string | undefined {
	if (typeof by !== "string") return undefined;
	if (NODE.test(by)) {
		// One naming no machine reads no record, as `hereFor` reads none.
		const named = nodeMachine(by);
		if (named === undefined || from !== by) return undefined;
		return here !== undefined && named === here ? by : undefined;
	}
	if (!isAddress(by) || from.toUpperCase() !== by.toUpperCase()) {
		return undefined;
	}
	return by.toUpperCase();
}

/**
 * This machine's name, read by `readOff` only where a steer `read`
 * names a node, so an inbox of other steers reads no record; nothing
 * otherwise. It fails where the record is there but can't be read,
 * and its readers then refuse only the node's carries.
 */
async function hereFor(
	read: readonly { raw: string }[],
	readOff: (path: string) => Promise<string>,
): Promise<string | undefined> {
	return read.some(({ raw }) => nodeNamed(raw) !== undefined)
		? thisMachineOff(readOff)
		: undefined;
}

/** How long the record of this machine's name may take to read. */
export const HERE_READ_MS = 5_000;

/**
 * This machine's name as `hereFor` reads it, or why it is unread: one
 * that doesn't answer within `ms` is unread, so a stalled disk never
 * holds the person's own steers taken with a node's carry.
 */
export async function hereOr(
	read: readonly { raw: string }[],
	readOff: (path: string) => Promise<string>,
	ms: number = HERE_READ_MS,
): Promise<Here> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					Object.assign(new Error("no answer"), {
						code: `no answer within ${ms / 1000} s`,
					}),
				),
			ms,
		);
	});
	try {
		return await Promise.race([hereFor(read, readOff), late]);
	} catch (error) {
		return { unread: unreadHere(error) };
	} finally {
		clearTimeout(timer);
	}
}

/** This machine's name as `thisMachineRead` reads it, or why it is unread. */
export function hereHeld(): Here {
	try {
		return thisMachineRead();
	} catch (error) {
		return { unread: unreadHere(error) };
	}
}

/**
 * This machine's name, as its record says; nothing where none was read;
 * or, where the record is there but unread, why.
 */
export type Here = string | undefined | { readonly unread: string };

/**
 * The machine whose node the steer `raw` says chose its carry, read as
 * JSON reads it, so an `@` written as an escape is a node's all the
 * same; nothing for any other steer.
 */
export function nodeNamed(raw: string): string | undefined {
	try {
		const said: unknown = JSON.parse(raw);
		return typeof said === "object" &&
			said !== null &&
			"act" in said &&
			said.act === ORDERED_CARRY &&
			"by" in said &&
			typeof said.by === "string"
			? nodeMachine(said.by)
			: undefined;
	} catch {
		return undefined;
	}
}
