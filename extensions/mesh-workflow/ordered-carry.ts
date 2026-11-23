/**
 * A carry an orchestrator orders, or this machine's node chooses: the
 * steer `ordered-carry`. For an orchestrator, the mycelium node writes it
 * only once it has proved, from its own record, that the session asking
 * orchestrates this one's quest, stamping `by` with
 * the orchestrator's address (mycelium's PROTOCOL.md, A Carry an
 * Orchestrator Orders). The node also writes it for a carry it chose
 * itself to ease its stalled machine, stamping `by` with
 * `node@<machine>`, which this machine takes only as its own node's
 * name. It is never the person's Carry (pausing.ts), and nothing that
 * trusts the person's carry reads it: lib/mesh/steer.ts keeps it apart
 * from every act.
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
 * it ended is taken up again, by an order taken since if one is, and
 * not while another carry takes the session. A person's Carry that
 * then fails leaves that run for the person, who pressed it, to start
 * again. A second carry while one is under way, or
 * while a refusal stamped as it was asked is being written, is said on
 * screen alone, leaving the refusal file to the carry before it.
 *
 * Carried, it closes as the person's Carry does, saying in its journal
 * who ordered or chose it and why, a node's choice never as an order,
 * and ends any run that starts before it has closed, leaving any
 * later order.
 *
 * From the moment it is taken until it is refused, or, carried, until
 * its close lands, it holds the doors that would end the session's
 * process unasked (`hold`, lib/internal/carry/under-way.ts): the run it
 * waits out and the holds it looks at again leave the session idle, and
 * a park in that gap would end it with nothing written for its node;
 * carried, a door or a second carry before the close would end or carry
 * a session whose work is already elsewhere. A refusal lets go as it
 * begins, since it carries nothing: a park or restart while it is
 * written can lose it, which is taken over turning away a person's
 * Carry meanwhile.
 *
 * A stale context throws on every read. Whatever throws before an order
 * has said how it went, the hold taken included, refuses it; what
 * throws once it has, refused or carried, is only said. What is said on
 * screen, and the run taken up again, never stop a refusal being
 * written.
 */

import { readFile } from "node:fs/promises";
import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawnExec } from "../../lib/core/exec/index.ts";
import { createGitRebaser } from "../../lib/core/work/rebase.ts";
import { automatedText } from "../../lib/internal/automated.ts";
import { handoverOf } from "../../lib/internal/carry/handover.ts";
import { writeRefused } from "../../lib/internal/carry/ordered.ts";
import type { CarryHold } from "../../lib/internal/carry/under-way.ts";
import { thisMachineOff } from "../../lib/internal/machine/machine.ts";
import { questLoadedIn } from "../../lib/internal/quest/sessions/loaded.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace/workspace-root.ts";
import { treesHeldByNow } from "../../lib/internal/work-records.ts";
import {
	type Board,
	isCurrent,
	type Lease,
	RUN_KINDS,
} from "../../lib/mesh/lease.ts";
import {
	machineRecordUnread,
	nodeMachine,
	type OrderedCarry,
} from "../../lib/mesh/steer-who.ts";
import { holdsOf } from "./moving.ts";

export type { OrderedCarry } from "../../lib/mesh/steer-who.ts";

/**
 * How long an ordered carry waits for the run under way to end before it
 * refuses: ten minutes, inside the quarter hour mycelium waits for a
 * carry in all, so the node hears the refusal before it gives up.
 */
export const ORDERED_WAIT_MS = 10 * 60_000;

/** How often a waiting ordered carry looks at whether the run has ended. */
const ORDERED_LOOK_MS = 500;

/** How long a refusal may take to write before it is given up. */
export const REFUSE_WRITE_MS = 30_000;

/**
 * An ordered carry in words, by whoever chose it: an orchestrator's
 * order, or this machine's node's own choice, never said as an order.
 */
function carryOf(ordered: OrderedCarry): {
	readonly a: string;
	readonly as: string;
	readonly opens: string;
} {
	const node = nodeMachine(ordered.by);
	if (node === undefined) {
		return {
			a: `an ordered carry to ${ordered.to} by ${ordered.by}`,
			as: `as ${ordered.by} ordered`,
			opens: `${ordered.by} ordered this session carried to ${ordered.to}`,
		};
	}
	const whose = `the mycelium node on ${node}`;
	return {
		// Turned down as it was taken, it may be no node's here, so it is
		// only said to come from one.
		a:
			ordered.refused === undefined
				? `a carry to ${ordered.to} that ${whose} chose`
				: `a carry to ${ordered.to} said to come from ${whose}`,
		as: `as ${whose} chose`,
		opens: `The mycelium node on ${node} chose to carry this session to ${ordered.to}`,
	};
}

/** `words` with its first letter in capitals, to open a line. */
function opening(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}

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
	/**
	 * Hold the doors that would end the session's process unasked for a
	 * carry to `to` (lib/internal/carry/under-way.ts), until the answer's
	 * release, or, once carried, while the session closes.
	 */
	readonly hold: (to: string) => DoorsHeld;
	/** Carry its work for the machine `to`, settling once it is carried. */
	readonly carry: (to: string) => Promise<void>;
	/**
	 * Say why it refused where mycelium reads it, in this machine's
	 * handover beside its done file, whoever chose the carry. Stamped
	 * `at`, whenever it is written.
	 */
	readonly refuse: (why: string, at: Date) => Promise<void>;
	/** Say on screen what happened. */
	readonly tell: (text: string) => void;
	/**
	 * Whether a carry of this session is under way besides this
	 * ordering's, as a person's Carry is once a refusal has let go.
	 */
	readonly carrying?: () => boolean;
	/** End the session, as /exit does, saying `by` asked. */
	readonly close: (by: string) => void;
	/** Start a turn with these words, to take up a run it ended. */
	readonly carryOn: (text: string) => void;
	readonly waitMs?: number;
	readonly lookMs?: number;
	/** How long a refusal may take to write before it is given up. */
	readonly refuseMs?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/** Ordered carries for one session. */
export interface OrderedCarrying {
	/**
	 * A carry an orchestrator ordered or this machine's node chose:
	 * settles once carried or refused.
	 */
	order(ordered: OrderedCarry): Promise<void>;
	/** A run started: one is ended while a carry is under way. */
	started(): void;
	/** A turn ended, its tools done: the run waited on is ended. */
	turnEnded(): void;
}

/** The doors an order holds, as {@link OrderedCarryHost.hold} takes them. */
export interface DoorsHeld {
	/** Let them go, unless carried; a second call does nothing. */
	readonly release: () => void;
	/** Carried: kept while the session closes, through any release. */
	readonly carried: () => void;
}

/**
 * One order taken: the doors it holds, whether it ended a run, and
 * whether it has said how it went, by a refusal or by carrying, which
 * no later throw then says again.
 */
interface Taken {
	held: DoorsHeld;
	ended: boolean;
	settled: boolean;
}

/** Doors not yet held, as an order is before its hold is taken. */
const NO_DOORS: DoorsHeld = {
	release: () => undefined,
	carried: () => undefined,
};

/** Ordered carries, none under way. */
export function createOrderedCarrying(host: OrderedCarryHost): OrderedCarrying {
	const now = host.now ?? Date.now;
	const sleep =
		host.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const waitMs = host.waitMs ?? ORDERED_WAIT_MS;
	const lookMs = host.lookMs ?? ORDERED_LOOK_MS;
	const refuseMs = host.refuseMs ?? REFUSE_WRITE_MS;
	// The order under way, whose runs are ended while it is.
	let underWay: Taken | undefined;
	// Whether this session was carried, so it is closing: a later order
	// is left, and a run that starts is ended.
	let carried = false;
	// The run an order ended that waits to be taken up, with the order
	// that ended it and why that one couldn't go: taken up once, by the
	// first refusal to finish with no order under way, however many
	// orders ended runs while their refusals were written, and said as
	// the order's that ended the newest.
	let owed:
		| { readonly ordered: OrderedCarry; readonly why: string }
		| undefined;
	// Whether a refusal stamped as it was asked is being written, while
	// which a carry is said on screen alone, since its node may read that
	// refusal as its own. One stamped from its steer's name is older than
	// any carry begun since, so carries come through while it is written.
	let refusing = false;

	// Said on screen, never stopping what it goes with: a stale screen
	// throws, and a refusal or a carry must still be written.
	const say = (text: string) => {
		try {
			host.tell(text);
		} catch {
			// The screen is gone; what it said is written where it matters.
		}
	};

	const end = () => {
		if (underWay) underWay.ended = true;
		host.abort();
	};

	const refuse = async (taken: Taken, ordered: OrderedCarry, why: string) => {
		// Its node counts any refusal no older than the carry it began, and
		// began it before it put the steer, so a refusal stamped at the end
		// of that millisecond (a name floors it) is never a later carry's,
		// however late it is written. One whose steer's time can't be told,
		// or is named later than now, which no node's steer is, is stamped
		// as it is asked for, so no name can date a refusal ahead.
		const asked = now();
		const stamped = ordered.put !== undefined && ordered.put.getTime() <= asked;
		const at =
			stamped && ordered.put
				? new Date(ordered.put.getTime() + 1)
				: new Date(asked);
		taken.settled = true;
		if (taken.ended) owed = { ordered, why };
		if (underWay === taken) underWay = undefined;
		// Refused, it carries nothing, so it holds nothing while its refusal
		// is written: a later order, or a person's Carry, would otherwise be
		// turned away by a carry that isn't happening.
		taken.held.release();
		say(
			`This session refused ${carryOf(ordered).a}: ${why}. It stays here, working.`,
		);
		if (!stamped) refusing = true;
		// One not written in time is given up, as one that fails is, so it
		// never turns away every later carry; landing late, it reads as its
		// own carry's by its stamp, and replaces no newer refusal.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<"late">((done) => {
			timer = setTimeout(() => done("late"), refuseMs);
		});
		try {
			const written = await Promise.race([host.refuse(why, at), late]);
			if (written === "late") {
				say(
					`Its refusal wasn't written where mycelium reads it within ${refuseMs / 1000} s; it may still land there, or the carry waits out its time there.`,
				);
			}
		} catch (error) {
			say(
				`Its refusal couldn't be written where mycelium reads it, so the carry waits out its time there: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timer);
			if (!stamped) refusing = false;
		}
		// Whether its refusal was written, late or not at all, a run an
		// order ended is taken up again, once, unless the session is carried
		// since and closing, or another carry is taking it: told to carry on,
		// it would write into the conversation being carried that nothing
		// was. An order taken since takes it up in its turn, if it refuses
		// too, since it ends no run of its own on a session already idle; a
		// refusal that finished first has taken it up already.
		const debt = owed;
		if (debt === undefined || carried || underWay !== undefined) return;
		owed = undefined;
		if (host.carrying?.() === true) {
			say(
				"The run it ended isn't taken up: a carry begun since is taking this session.",
			);
			return;
		}
		try {
			// Headed as automated, so a host starting runs never counts it as Joel's.
			host.carryOn(
				automatedText(
					"a carry couldn't go",
					`${opening(carryOf(debt.ordered).a)} ended this run to go, then couldn't: ${debt.why}. Nothing was carried; carry on where you left off.`,
				),
			);
		} catch (error) {
			say(
				`The run it ended couldn't be taken up: ${error instanceof Error ? error.message : String(error)}`,
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

	/** Carries a taken order, or refuses it, saying why. */
	const carryOrdered = async (
		taken: Taken,
		ordered: OrderedCarry,
	): Promise<void> => {
		taken.held = host.hold(ordered.to);
		const before = await host.holds(false);
		if (before !== undefined) return refuse(taken, ordered, before);
		if (!host.idle()) {
			say(
				`${carryOf(ordered).opens}, for ${ordered.why}: letting the turn under way end first.`,
			);
		}
		if (!(await runEnds())) {
			return refuse(
				taken,
				ordered,
				`its run didn't end within ${waitMs / 1000} s`,
			);
		}
		const after = await host.holds(true);
		if (after !== undefined) return refuse(taken, ordered, after);
		try {
			await host.carry(ordered.to);
		} catch (error) {
			return refuse(
				taken,
				ordered,
				`its work couldn't be carried: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Carried, its done file written: nothing after this refuses it, and
		// its doors stay held while it closes, so neither a door nor a
		// second carry, a person's included, goes before the close lands.
		taken.settled = true;
		carried = true;
		taken.held.carried();
		if (underWay === taken) underWay = undefined;
		say(
			`Carried to ${ordered.to}, ${carryOf(ordered).as} for ${ordered.why}; closing.`,
		);
		host.close(`${carryOf(ordered).a}, for ${ordered.why}`);
	};

	return {
		async order(ordered) {
			// No node here began it, or none can be told to have, and this
			// machine's node reads its handover, where it could take a refusal
			// of this one as its own carry's: said on screen alone, touching
			// nothing a live carry or a refusal being written holds.
			if (ordered.refused !== undefined) {
				say(
					`This session refused ${carryOf(ordered).a}: ${ordered.refused}. It stays here, working.`,
				);
				return;
			}
			// Said on screen alone: the node counts any refusal no older than
			// its steer, so one written now would read as the live carry's,
			// and one stamped as it was asked, being written, as this one's.
			if (carried) {
				say(
					`${opening(carryOf(ordered).a)} came once this session was carried, so it is left: it is closing.`,
				);
				return;
			}
			if (refusing) {
				say(
					`${opening(carryOf(ordered).a)} came while a refusal is being written, so it is left unanswered: its node may read that refusal as this one's, or waits out its time.`,
				);
				return;
			}
			if (underWay) {
				say(
					`${opening(carryOf(ordered).a)} came while a carry is under way, so it is left to the one under way.`,
				);
				return;
			}
			const taken: Taken = { held: NO_DOORS, ended: false, settled: false };
			underWay = taken;
			try {
				await carryOrdered(taken, ordered);
			} catch (error) {
				const said = error instanceof Error ? error.message : String(error);
				// A hold or a look that threw, as a stale context's does, is
				// refused like any hold, so its node isn't left waiting out its
				// time. One that has said how it went, refused or carried, says
				// only what threw after: never a refusal of a carry that went.
				if (taken.settled) {
					say(`After ${carryOf(ordered).a} was settled: ${said}`);
				} else {
					// It says its own failures, so nothing is left to say here.
					await refuse(
						taken,
						ordered,
						`it couldn't be looked at: ${said}`,
					).catch(() => undefined);
				}
			} finally {
				if (underWay === taken) underWay = undefined;
				taken.held.release();
			}
		},
		// Carried, it ends a run that starts before it has closed, as the
		// person's Carry does: what the run did would be missing from the
		// session carried.
		started() {
			if (underWay || carried) end();
		},
		turnEnded() {
			if ((underWay || carried) && !host.idle()) end();
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

/**
 * The first tree `session` holds with a rebase halted part-way, said;
 * or, when the trees it holds can't be read for now, that: a carry that
 * can't see a tree mustn't leave it behind unasked.
 */
async function rebaseHalted(session: string): Promise<string | undefined> {
	const rebaser = createGitRebaser({ exec: spawnExec() });
	let trees: string[];
	try {
		trees = await treesHeldByNow(session);
	} catch (error) {
		return `the trees it holds can't be told: ${error instanceof Error ? error.message : String(error)}`;
	}
	for (const tree of trees) {
		if (await rebaser.halted(tree).catch(() => false)) {
			return `a rebase is halted part-way in ${tree}`;
		}
	}
	return undefined;
}

/**
 * Writes `session`'s refusal into its quest's handover for this
 * machine, beside the done file, where mycelium looks whoever chose the
 * carry: the folder is named as the done file's is, by this machine's
 * name, never by a `node@` name, so no carry's refusal lands in another
 * machine's folder. Throws when no quest is loaded, since then there is no
 * handover to write it in. It is stamped `at`, as its carry's steer was
 * put, so one written late, after its carry was given up on, reads as
 * older than any carry that began since; it is asked for, never
 * defaulted, so no caller can leave it out. The machine's name is read
 * off the thread, and while its record is there but can't be read it
 * throws, writing nothing: its node reads its folder by that record's
 * name, which the hostname may not be, and a stalled read must not
 * hold the session.
 */
export async function refuseInHandover(
	session: string,
	why: string,
	at: Date,
): Promise<void> {
	const quest = await questLoadedIn(session);
	if (quest === undefined) {
		throw new Error(
			"no quest is loaded, so its refusal has no handover to go in",
		);
	}
	let here: string;
	try {
		here = await thisMachineOff((path) => readFile(path, "utf8"));
	} catch (error) {
		// Said as the record and its file, never a bare code the person
		// can't place.
		throw new Error(machineRecordUnread(error));
	}
	writeRefused(handoverOf(questWorkspacesRoot(), quest, here), {
		session,
		why,
		at,
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
	/** The asking carry's own hold, which holds nothing against it. */
	readonly ownCarry?: CarryHold;
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
		holdsOf(at.ctx, at.events, at.prompts, {
			runAside: true,
			ownCarry: at.ownCarry,
		}) ??
		leasesHolding(at.board, at.session, runEnded) ??
		(await rebaseHalted(at.session))
	);
}
