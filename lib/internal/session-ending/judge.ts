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
 * for the name.
 */

import type { NodeSession } from "../../mesh/node.ts";
import type { SessionEndingAsk } from "./asks.ts";

/** How many live sessions a refusal names before it counts the rest. */
const NAMED = 8;

/**
 * The machines an ask can name: those the node knows, else this one,
 * so an ask of it is still read when the node can't be.
 */
export function machinesKnown(
	sessions: readonly NodeSession[] | undefined,
	here: string,
): string[] {
	if (!sessions) return [here];
	return [...new Set(sessions.map((one) => one.machine))];
}

/**
 * Why `asks` may not go to the person, or nothing when they may: the
 * sessions each would end, other than `self`, or that the node, whose
 * answer is `sessions`, couldn't be read.
 */
export function refusalOf(
	asks: readonly SessionEndingAsk[],
	sessions: readonly NodeSession[] | undefined,
	self: string | undefined,
): string | undefined {
	const [first] = asks;
	if (!first) return undefined;
	if (!sessions) {
		return `Not asked: this asks the person to ${first.act}${onMachines(first.machines)}, and the machine's mycelium node couldn't be read to say which sessions that would end. Ask again once the node answers.`;
	}
	for (const ask of asks) {
		const unnamed = ask.machines.length === 0;
		const reach = unnamed
			? new Set(sessions.map((one) => one.machine))
			: new Set(ask.machines.map((name) => name.toLowerCase()));
		const live = sessions.filter(
			(one) =>
				reach.has(unnamed ? one.machine : one.machine.toLowerCase()) &&
				one.state !== "ended" &&
				one.id !== self,
		);
		if (live.length === 0) continue;
		const where = unnamed
			? " It names no machine, so every machine the node knows was checked: name the one it means."
			: "";
		return `Not asked: this asks the person to ${ask.act}${onMachines(ask.machines)}, which would end the other pi sessions live there: ${named(live, unnamed)}.${where} Ask only once none is left there: tell your orchestrator what needs it, to schedule with the person once those sessions are ended or carried.`;
	}
	return undefined;
}

function onMachines(machines: readonly string[]): string {
	return machines.length === 0 ? "" : ` on ${machines.join(" and ")}`;
}

/**
 * Live sessions as their addresses and states, so many by name, with
 * their machines when the ask named none.
 */
function named(live: readonly NodeSession[], withMachine: boolean): string {
	const said = live
		.slice(0, NAMED)
		.map(
			(one) =>
				`${one.address ?? one.id} (${one.state})${withMachine ? ` on ${one.machine}` : ""}`,
		)
		.join(", ");
	const more = live.length - NAMED;
	return more > 0 ? `${said} and ${more} more` : said;
}
