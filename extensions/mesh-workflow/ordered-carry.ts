/**
 * A carry an orchestrator orders: the steer `ordered-carry`, which the
 * mycelium node writes only once it has proved, from its own record, that
 * the session asking orchestrates this one's quest, stamping `by` with
 * the orchestrator's address (mycelium's PROTOCOL.md, A Carry an
 * Orchestrator Orders). It is never the person's Carry (pausing.ts), and
 * nothing that trusts the person's carry reads it: lib/mesh/steer.ts
 * keeps it apart from every act.
 *
 * ISXEG8 ruled on 15 November that an agent may order a carry on five
 * conditions; this is the session's part of the fourth. It carries only
 * when nothing of its own would be lost: no background job out (a work
 * push moved to the background is one), no lease held by it or its
 * hands, no rebase halted part-way in a tree it holds, no message
 * waiting, no prompt open for the person, no words typed and unsent.
 * Any of those refuses at once, the run under way untouched. A run under
 * way alone is let finish the turn it is on, as Pause does, and any other
 * run that starts meanwhile is ended; once it has ended, what holds is
 * looked at again, a run's own leases now counting too. A run that
 * doesn't end within {@link ORDERED_WAIT_MS} refuses, as does a carry
 * that fails. Every refusal says why, writes it where mycelium reads it
 * (lib/internal/carry/ordered.ts), and leaves the session working: a run
 * it ended is taken up again. A second order while one is under way is
 * said on screen alone, leaving the refusal file to the live carry.
 *
 * Carried, it closes as the person's Carry does, saying in its journal
 * who ordered it and why.
 */

import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawnExec } from "../../lib/core/exec/index.ts";
import { createGitRebaser } from "../../lib/core/work/rebase.ts";
import { automatedText } from "../../lib/internal/automated.ts";
import { handoverOf } from "../../lib/internal/carry/handover.ts";
import { writeRefused } from "../../lib/internal/carry/ordered.ts";
import { thisMachine } from "../../lib/internal/machine/machine.ts";
import { questLoadedIn } from "../../lib/internal/quest/sessions/loaded.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace/workspace-root.ts";
import { treesHeldBy } from "../../lib/internal/work-records.ts";
import {
	type Board,
	isCurrent,
	type Lease,
	RUN_KINDS,
} from "../../lib/mesh/lease.ts";
import type { OrderedCarry } from "../../lib/mesh/steer.ts";
import { holdsOf } from "./moving.ts";

export type { OrderedCarry } from "../../lib/mesh/steer.ts";

/**
 * How long an ordered carry waits for the run under way to end before it
 * refuses: ten minutes, inside the quarter hour mycelium waits for a
 * carry in all, so the node hears the refusal before it gives up.
 */
export const ORDERED_WAIT_MS = 10 * 60_000;

/** How often a waiting ordered carry looks at whether the run has ended. */
const ORDERED_LOOK_MS = 500;

/** What an ordered carry needs from its session. */
export interface OrderedCarryHost {
	/** Whether the session is between runs. */
	readonly idle: () => boolean;
	/** End the run in progress. */
	readonly abort: () => void;
	/**
	 * What keeps it here besides a run under way, or nothing; `runEnded`
	 * once the run has ended, when a run's own leases count too.
	 */
	readonly holds: (runEnded: boolean) => Promise<string | undefined>;
	/** Carry its work for the machine `to`, settling once it is carried. */
	readonly carry: (to: string) => Promise<void>;
	/** Say why it refused where mycelium reads it. */
	readonly refuse: (why: string) => Promise<void>;
	/** Say on screen what happened. */
	readonly tell: (text: string) => void;
	/** End the session, as /exit does, saying `by` asked. */
	readonly close: (by: string) => void;
	/** Start a turn with these words, to take up a run it ended. */
	readonly carryOn: (text: string) => void;
	readonly waitMs?: number;
	readonly lookMs?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/** Ordered carries for one session. */
export interface OrderedCarrying {
	/** The node ordered this carry: settles once carried or refused. */
	order(ordered: OrderedCarry): Promise<void>;
	/** A run started: one is ended while a carry is under way. */
	started(): void;
	/** A turn ended, its tools done: the run waited on is ended. */
	turnEnded(): void;
}

/** Ordered carries, none under way. */
export function createOrderedCarrying(host: OrderedCarryHost): OrderedCarrying {
	const now = host.now ?? Date.now;
	const sleep =
		host.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const waitMs = host.waitMs ?? ORDERED_WAIT_MS;
	const lookMs = host.lookMs ?? ORDERED_LOOK_MS;
	let underWay = false;
	// Whether this carry ended a run, which a refusal then takes up again.
	let ended = false;

	const end = () => {
		ended = true;
		host.abort();
	};

	const refuse = async (ordered: OrderedCarry, why: string) => {
		const tookUp = ended;
		underWay = false;
		ended = false;
		host.tell(
			`This session refused an ordered carry to ${ordered.to} by ${ordered.by}: ${why}. It stays here, working.`,
		);
		try {
			await host.refuse(why);
		} catch (error) {
			host.tell(
				`Its refusal couldn't be written where mycelium reads it, so the carry waits out its time there: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (tookUp) {
			// Headed as automated, so a host starting runs never counts it as Joel's.
			host.carryOn(
				automatedText(
					"an ordered carry couldn't go",
					`An ordered carry to ${ordered.to} by ${ordered.by} ended this run to go, then couldn't: ${why}. Nothing was carried; carry on where you left off.`,
				),
			);
		}
	};

	/** Waits for the run under way to end, answering whether it did. */
	const runEnds = async () => {
		const until = now() + waitMs;
		while (!host.idle()) {
			if (now() >= until) return false;
			await sleep(lookMs);
		}
		return true;
	};

	return {
		async order(ordered) {
			// Said on screen alone: the node counts any refusal no older than
			// its order, so one written now would read as the live carry's.
			if (underWay) {
				host.tell(
					`An ordered carry to ${ordered.to} by ${ordered.by} came while a carry is under way, so it is left to the one under way.`,
				);
				return;
			}
			underWay = true;
			const before = await host.holds(false);
			if (before !== undefined) return refuse(ordered, before);
			if (!host.idle()) {
				host.tell(
					`${ordered.by} ordered this session carried to ${ordered.to}, for ${ordered.why}: letting the turn under way end first.`,
				);
			}
			if (!(await runEnds())) {
				return refuse(ordered, `its run didn't end within ${waitMs / 1000} s`);
			}
			const after = await host.holds(true);
			if (after !== undefined) return refuse(ordered, after);
			try {
				await host.carry(ordered.to);
			} catch (error) {
				return refuse(
					ordered,
					`its work couldn't be carried: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			host.tell(
				`Carried to ${ordered.to}, as ${ordered.by} ordered for ${ordered.why}; closing.`,
			);
			host.close(
				`an ordered carry to ${ordered.to} by ${ordered.by}, for ${ordered.why}`,
			);
		},
		started() {
			if (underWay) end();
		},
		turnEnded() {
			if (underWay && !host.idle()) end();
		},
	};
}

/** What holding a lease is said as: its kind and what it claims. */
function leaseSaid(lease: Lease): string {
	return `${lease.kind} on ${lease.subject}`;
}

/**
 * The current leases `session` holds, and those its hands hold for it,
 * as a reason it can't go; nothing when it holds none. A run's own
 * leases (a change, an answer) count only once `runEnded`, since the run
 * ending gives them up.
 */
export function leasesHolding(
	board: Board,
	session: string,
	runEnded: boolean,
	at: number = Date.now(),
): string | undefined {
	const hands = board
		.all()
		.filter((holding) => holding.handOf === session)
		.sort((one, other) => one.session.localeCompare(other.session));
	const held = [board.of(session), ...hands]
		.flatMap((holding) => holding?.leases ?? [])
		.filter(
			(lease) =>
				isCurrent(lease, at) && (runEnded || !RUN_KINDS.has(lease.kind)),
		);
	if (held.length === 0) return undefined;
	const count = held.length === 1 ? "a lease" : `${held.length} leases`;
	return `it holds ${count} (${held.map(leaseSaid).join("; ")})`;
}

/** The first tree `session` holds with a rebase halted part-way, said. */
async function rebaseHalted(session: string): Promise<string | undefined> {
	const rebaser = createGitRebaser({ exec: spawnExec() });
	for (const tree of treesHeldBy(session)) {
		if (await rebaser.halted(tree).catch(() => false)) {
			return `a rebase is halted part-way in ${tree}`;
		}
	}
	return undefined;
}

/**
 * Writes `session`'s refusal into its quest's handover on this machine,
 * where mycelium looks beside the done file; throws when no quest is
 * loaded, since then there is no handover to write it in.
 */
export async function refuseInHandover(
	session: string,
	why: string,
): Promise<void> {
	const quest = await questLoadedIn(session);
	if (quest === undefined) {
		throw new Error(
			"no quest is loaded, so its refusal has no handover to go in",
		);
	}
	writeRefused(handoverOf(questWorkspacesRoot(), quest, thisMachine()), {
		session,
		why,
		at: new Date(),
	});
}

/** Where what holds a session is read from. */
export interface HoldsAt {
	readonly ctx: ExtensionContext | undefined;
	readonly events: EventBus | undefined;
	/** Prompts open for the person. */
	readonly prompts: number;
	readonly board: Board;
	readonly session: string;
}

/**
 * What keeps a session from an ordered carry besides a run under way:
 * what would keep it from moving (moving.ts's holdsOf, its run aside),
 * the leases it holds, and a rebase halted in a tree it holds.
 */
export async function orderedHolds(
	at: HoldsAt,
	runEnded: boolean,
): Promise<string | undefined> {
	return (
		holdsOf(at.ctx, at.events, at.prompts, { runAside: true }) ??
		leasesHolding(at.board, at.session, runEnded) ??
		(await rebaseHalted(at.session))
	);
}
