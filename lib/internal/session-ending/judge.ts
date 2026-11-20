/**
 * Whether an ask to end a machine's sessions may go to the person.
 *
 * It may not while the machine's mycelium node says any session other
 * than the asker's is on that machine in any state but ended: an idle
 * session ends with a log-out as surely as a busy one, and one whose
 * link dropped may still be running. Nor may it when the node can't be
 * read, since then nothing says whom it would end. This is the rule of
 * EWUL44's se7_guard_no_live_sessions, which refuses its pairing
 * script's log-out the same way.
 *
 * An ask that names no machine is checked against every machine the
 * node knows, since nothing says which it means, and the refusal asks
 * for the name. A session in a state this reader doesn't know counts as
 * live, and one the node names no machine for counts as on every
 * machine: a guess either way would be the one that ends a run.
 *
 * Two things this machine knows of itself spare its own sessions. A
 * log-out or a switch of users leaves the user's services running when
 * the user lingers and logind kills no user processes, so a session a
 * pi host runs or a holder holds outlives it; one in a terminal alone
 * does not. And a session whose presence and marker say it parked,
 * idle with nothing of its own still out, holds nothing a reboot,
 * restart or shut-down could lose, and the next boot clears its marker:
 * while the node reads it as idle in a pi host it doesn't count for
 * one, whoever asks. Any other ending leaves its marker standing after
 * its host has gone, so it still counts. A holder's parked session already reads as ended, so
 * one the node reads idle with a holder, or with neither, is running
 * whatever its presence says; a host's reads idle, since the host lives
 * on. One the node reads busy or out of reach still counts. Neither
 * reaches another machine, or a session the node names no machine for,
 * since nothing here says what lingers or is held there.
 */

import type { NodeSession } from "../../mesh/node.ts";
import { GUARDS } from "../guardian/guards.ts";
import { isMachineName } from "../machine/machine.ts";
import type { SessionEndingAsk } from "./asks.ts";

/** How many live sessions a refusal names before it counts the rest. */
const NAMED = 8;

/**
 * The machines an ask can name: those the node's sessions are on and
 * those its realm lists with none on them. When the sessions can't be
 * read, this one stands in for theirs beside what the realm lists, so
 * an ask of a machine is still read as one.
 */
export function machinesKnown(
	sessions: readonly NodeSession[] | undefined,
	listed: readonly string[] | undefined,
	here: string,
): string[] {
	return [
		...new Set([
			...(sessions ?? [{ machine: here }]).flatMap((one) => one.machine ?? []),
			...(listed ?? []),
		]),
	].filter(isMachineName);
}

/**
 * Why an ask may not go to the person, and what the refusal is known
 * again by: the asks refused, each its act and machines, rather than the
 * reason, whose sessions move between busy and idle in seconds, so an
 * override under redirect holds when the same asks are made again, and
 * only then: an ask added beside them is a new refusal.
 */
export interface Refusal {
	readonly reason: string;
	readonly key: string;
}

/** What this machine knows of itself that spares its own sessions. */
export interface Here {
	/** This machine's name. */
	readonly machine: string;
	/** Whether a log-out here leaves the user's services running. */
	readonly lingers: boolean;
	/** The sessions, by id, whose presence and marker say they parked. */
	readonly parked: ReadonlySet<string>;
}

/** The acts that end a log-in but not the user's services. */
const ENDS_A_LOG_IN: ReadonlySet<SessionEndingAsk["act"]> = new Set([
	"log out",
	"switch users",
]);

/**
 * The acts that end the boot, whose next boot clears this one's park
 * markers. Any other ending leaves a parked session's marker saying this
 * boot after its waker has gone, so the mesh writes wakes nothing reads.
 */
const ENDS_THE_BOOT: ReadonlySet<SessionEndingAsk["act"]> = new Set([
	"reboot",
	"restart",
	"shut down",
]);

/** The guard a person sets off to let such an ask through. */
const GUARD_NAME = GUARDS.noSessionEndingAskWhileLive.name;

/**
 * Why `asks` may not go to the person, or nothing when they may: the
 * sessions each would end, other than `self` and those `here` spares,
 * or that the node, whose answer is `sessions`, couldn't be read.
 */
export function refusalOf(
	asks: readonly SessionEndingAsk[],
	sessions: readonly NodeSession[] | undefined,
	self: string | undefined,
	here?: Here,
): Refusal | undefined {
	const [first] = asks;
	if (!first) return undefined;
	if (!sessions) {
		const reason = `Not asked: this asks the person to ${first.act}${onMachines(first.machines)}${alsoOf(asks.slice(1))}, and the machine's mycelium node couldn't be read to say which sessions that would end. Ask again once the node answers; where no node runs at all, the person can turn the ${GUARD_NAME} guard off.`;
		return { reason, key: keyOf(asks, "unread") };
	}
	const refused = asks.flatMap((ask) => {
		const live = liveFor(ask, sessions, self, here);
		return live.length === 0 ? [] : [{ ask, live }];
	});
	const [worst] = refused;
	if (!worst) return undefined;
	const { ask, live } = worst;
	const unnamed = ask.machines.length === 0;
	const where = unnamed
		? " It names no machine, so every machine the node knows was checked: name the one it means."
		: "";
	const also = alsoOf(refused.slice(1).map((one) => one.ask));
	const reason = `Not asked: this asks the person to ${ask.act}${onMachines(ask.machines)}${also}, which would end the other pi sessions live there: ${named(live, unnamed)}.${where} Ask only once none is left there: tell your orchestrator what needs it, to schedule with the person once those sessions are ended or carried.`;
	return {
		reason,
		key: keyOf(
			refused.map((one) => one.ask),
			"live",
		),
	};
}

/** The sessions other than `self` that `ask` would end. */
function liveFor(
	ask: SessionEndingAsk,
	sessions: readonly NodeSession[],
	self: string | undefined,
	here: Here | undefined,
): NodeSession[] {
	const unnamed = ask.machines.length === 0;
	const reach = new Set(ask.machines.map((name) => name.toLowerCase()));
	return sessions.filter(
		(one) =>
			(unnamed ||
				one.machine === undefined ||
				reach.has(one.machine.toLowerCase())) &&
			one.state !== "ended" &&
			one.id !== self &&
			!spares(here, ask, one),
	);
}

/** Whether what `here` knows of itself says `ask` leaves `one` running. */
function spares(
	here: Here | undefined,
	ask: SessionEndingAsk,
	one: NodeSession,
): boolean {
	if (!here || one.machine?.toLowerCase() !== here.machine.toLowerCase()) {
		return false;
	}
	if (
		ENDS_THE_BOOT.has(ask.act) &&
		one.state === "idle" &&
		one.host !== undefined &&
		here.parked.has(one.id)
	)
		return true;
	return (
		here.lingers &&
		ENDS_A_LOG_IN.has(ask.act) &&
		(one.host !== undefined || one.held !== undefined)
	);
}

/** The other asks refused beside the first, said after it. */
function alsoOf(asks: readonly SessionEndingAsk[]): string {
	if (asks.length === 0) return "";
	const said = asks.map((ask) => `${ask.act}${onMachines(ask.machines)}`);
	return ` (and to ${said.join(", ")})`;
}

/** A refusal of `asks` for `why`, as the same asks made again are known. */
function keyOf(
	asks: readonly SessionEndingAsk[],
	why: "live" | "unread",
): string {
	const each = asks.map(
		(ask) =>
			`${ask.act}:${ask.machines.map((name) => name.toLowerCase()).join(",")}`,
	);
	return `${why}:${[...new Set(each)].sort().join("|")}`;
}

function onMachines(machines: readonly string[]): string {
	return machines.length === 0
		? ""
		: ` on ${machines.map(clean).join(" and ")}`;
}

/**
 * A machine's name the node or a reply gave, as a machine can have it,
 * else a plain word, so nothing it holds reads as an instruction.
 */
function clean(name: string): string {
	return isMachineName(name) && name.length <= LONGEST_NAME
		? name
		: "a machine";
}

/** The longest machine name said as it is. */
const LONGEST_NAME = 32;

/** What a mesh address looks like: a few capitals and digits. */
const ADDRESS = /^[A-Z0-9]{4,12}$/;

/** What a session's state looks like: a short lowercase word. */
const STATE = /^[a-z][a-z-]{0,15}$/;

/**
 * Live sessions as their addresses and states, so many by name, with
 * their machines when the ask named none. An address or state of a
 * shape the node doesn't give is said as a plain word, since a session
 * record from another node could hold anything.
 */
function named(live: readonly NodeSession[], withMachine: boolean): string {
	const said = live
		.slice(0, NAMED)
		.map((one) => {
			const address =
				one.address !== undefined && ADDRESS.test(one.address)
					? one.address
					: "a session";
			const state = STATE.test(one.state) ? one.state : "other";
			const on = withMachine && one.machine ? ` on ${clean(one.machine)}` : "";
			return `${address} (${state})${on}`;
		})
		.join(", ");
	const more = live.length - NAMED;
	return more > 0 ? `${said} and ${more} more` : said;
}
