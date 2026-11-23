/**
 * Leases at the pi edge: taking them as this peer works, telling those
 * involved when two overlap, and noticing when a hold this peer waits
 * on is over (see lib/mesh/lease.ts).
 *
 * The harness takes most leases itself, since agents tell others what
 * they are doing only when it is the easy thing (the swarm's posts went
 * 92% through the root): an edit claims its file, a git command that
 * rewrites a checkout's files claims the checkout, a turn claims the
 * questions it carries, a hold sent claims what it holds, and answering
 * another's hold says this peer waits on it.
 *
 * Heavy work is claimed too, read by the queue's own map (kindOf), so a
 * hold stops what the queue would queue and nothing else. Two peers'
 * heavy work at once is told to them only where the machine's queue is
 * not kept: where it is, the queue gives each its turn by the room
 * left, and mesh_groups says what each peer runs or waits for from the
 * queue's record rather than from these leases.
 *
 * leases/ holds what changes for its own reasons: heavy-calls.ts, the
 * heavy work each tool call claims and carries across a reload, and
 * said.ts, how mesh_groups says a peer's leases. Both are exported
 * from here too, so what imports leasing imports it from one place.
 */

import {
	isKept,
	machineQueueDir,
	type QueueRecord,
	readQueue,
} from "../../lib/internal/priority/folder.ts";
import { answeringTo } from "../../lib/mesh/address.ts";
import { homeOf } from "../../lib/mesh/group.ts";
import {
	type Board,
	changeOf,
	claimsCheckout,
	HEAVY_MS,
	type Held,
	isCurrent,
	type Lease,
	type LeaseEvent,
	MOST_HOLD_MS,
	type OwnLeases,
	othersIn,
	othersOn,
	RUN_LEASE_MS,
	rewriteIn,
} from "../../lib/mesh/lease.ts";
import { census } from "../../lib/mesh/liveness.ts";
import { clock, type Message, senderIdentity } from "../../lib/mesh/message.ts";
import { oneLine } from "../../lib/mesh/one-line.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import type { Presence, Presences } from "../../lib/mesh/presence.ts";
import { mayReplace, sentBy } from "../../lib/mesh/thread.ts";
import type { Told } from "../../lib/mesh/told.ts";
import type { Transport } from "../../lib/mesh/transport.ts";
import { heavySaid } from "./leases/heavy-calls.ts";

export {
	createHeavyCalls,
	heavySaid,
	parkHeavyCalls,
	reloading,
	type TakenCall,
	takeHeavyCalls,
} from "./leases/heavy-calls.ts";
export { leasesText } from "./leases/said.ts";

/** Whether the machine's queue is kept, as this environment finds it. */
export function queueKept(env: NodeJS.ProcessEnv): boolean {
	const dir = machineQueueDir(env);
	return dir !== undefined && isKept(dir);
}

/** The machine queue's jobs, while some session keeps it. */
export function queueJobs(
	env: NodeJS.ProcessEnv,
): QueueRecord["jobs"] | undefined {
	const dir = machineQueueDir(env);
	return dir === undefined ? undefined : readQueue(dir)?.jobs;
}

/** How much of a message a lease keeps as what it is for. */
const WHY_CHARS = 120;

/** A hold this peer waited on that is over, and how it ended. */
export interface HoldEnd {
	readonly hold: Message;
	readonly how: string;
	/**
	 * Whether its holder said it was over. One that lapsed, or whose
	 * holder ended, may still hold what it named.
	 */
	readonly said: boolean;
	/** What this peer said it had put off for it. */
	readonly why?: string;
}

/**
 * Who leases, as leasing knows it: a peer, or a hand standing in for
 * the peer it works for (see lib/mesh/hand.ts).
 */
export type Leaser = Pick<Peer, "session" | "signature" | "addresses">;

/** What leasing needs of the session around it. */
export interface LeaseSurroundings {
	readonly board: Board;
	readonly presences: Presences;
	readonly transport: Transport;
	own(): OwnLeases | undefined;
	peer(): Leaser | undefined;
	/** Note a message the mesh sent for this peer, so it is never handed back. */
	sent(message: Message): void;
	/**
	 * How the leaser can ask the peers it overlaps, in a phrase: a peer
	 * asks with mesh_send, and a hand through the session that started it.
	 */
	readonly asking?: string;
	/**
	 * Whether the machine's queue is kept, so heavy work takes turns by
	 * itself and two peers' running at once needs no word between them.
	 */
	queueKept?(): boolean;
	/**
	 * When the machine booted, in milliseconds, or nothing where it will
	 * not say: nothing anybody started before then is still under way.
	 */
	booted?(): number | undefined;
	/**
	 * Who this peer's processes have told of an overlap within the hour,
	 * so a subagent, a hand, a reload or a new run of the holder's does
	 * not tell the same holder of the same thing again (lib/mesh/told.ts).
	 */
	readonly told?: Told;
}

/**
 * What an edit meets when another peer is changing the same file: a
 * stop, once, when that peer works in this checkout, or a note for the
 * edit's result when it works in another worktree of the repository,
 * where its copy of the file is its own and only a later merge can
 * clash.
 */
export type Reached = { readonly stop: string } | { readonly note: string };

export interface Leasing {
	/**
	 * Before this peer changes a file: nothing when it may, or what it
	 * meets when another peer is changing it.
	 */
	reach(path: string, cwd: string): Promise<Reached | undefined>;
	/**
	 * Before this peer runs a shell command: nothing when it may, or why
	 * not yet, once, when it rewrites the files of a checkout another
	 * peer is changing files in.
	 */
	rewrite(command: string, cwd: string): Promise<string | undefined>;
	/** Claim the questions a turn of this peer's carries. */
	answering(messages: readonly Message[]): void;
	/**
	 * Keep claimed what the run still answers, as each turn ends, so a
	 * long answer is not read by the peers that left it as one let go.
	 */
	stillAnswering(): void;
	/** The peer answering this question, when another is. */
	answeredBy(message: Message): Promise<string | undefined>;
	/** What a message this peer sent claims, or ends. */
	sent(message: Message): void;
	/** The hold a message ends, when this peer waits on it. */
	ended(message: Message): HoldEnd | undefined;
	/** The holds this peer waits on that have lapsed or lost their holder. */
	lapsed(now?: number): Promise<HoldEnd[]>;
	/** Heavy work this peer starts or stops; what to say when it overlaps. */
	heavy(event: LeaseEvent): Promise<string | undefined>;
	/**
	 * Let go of what this peer claimed before the machine last booted,
	 * but its waits, which end by `lapsed` so it hears they are over.
	 */
	forgetEarlierBoots(): void;
}

export function createLeasing(at: LeaseSurroundings): Leasing {
	const asking = at.asking ?? "ask with mesh_send";
	// Each overlap is refused once in this process: a lease another peer
	// took is known by its holder and when it was taken, so a new run's
	// claim is refused again. Whether its holder is sent word is kept
	// apart, on disk for every process of this peer (`at.told`).
	const told = new Set<string>();
	const key = (held: Held) =>
		`${held.lease.kind}|${held.lease.subject}|${held.session}|${held.lease.since}`;

	/** The peers still there, by session, answering to every address. */
	const standing = async () => {
		const everyone = at.presences.all();
		const judged = await census(
			everyone.map((one) => ({
				...one,
				addresses: answeringTo(one, everyone),
			})),
		);
		return {
			present: new Map(judged.present.map((one) => [one.session, one])),
			gone: judged.gone,
		};
	};

	/** The overlapping leases of peers still there not yet told of this one. */
	const untold = async (held: readonly Held[]) => {
		if (held.length === 0) return [];
		const { present } = await standing();
		return held.flatMap((one) => {
			const holder = present.get(one.session);
			return holder && !told.has(key(one)) ? [{ ...one, holder }] : [];
		});
	};

	const tell = (holder: Presence, about: Held, text: string) => {
		const peer = at.peer();
		const address = holder.addresses[0];
		if (!peer || !address) return;
		const telling = {
			teller: peer.signature,
			holder: holder.session,
			kind: about.lease.kind,
			subject: about.lease.subject,
		};
		const now = Date.now();
		if (at.told?.already(telling, now)) return;
		at.told?.note(telling, now);
		at.sent(
			at.transport.send({
				from: peer.signature,
				to: [homeOf(address)],
				intent: "fyi",
				text,
				...senderIdentity(),
			}),
		);
	};

	return {
		async reach(path, cwd) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return undefined;
			const now = Date.now();
			const { subject, checkout } = changeOf(path, cwd);
			if (!own.held("change", subject, now)) {
				const board = at.board.all();
				const overlapping = await untold([
					...othersOn(board, peer.session, "change", subject, now),
					...(checkout
						? othersIn(board, peer.session, checkout, now).filter(({ lease }) =>
								claimsCheckout(lease),
							)
						: []),
				]);
				const here = overlapping.filter(
					(one) => !inAnotherCheckout(one.lease, checkout),
				);
				if (here.length === 0 && overlapping.length > 0) {
					// Its holder is not told: what it changes is its own copy, and
					// a peer in another worktree is nothing it can act on.
					for (const one of overlapping) told.add(key(one));
					own.take("change", subject, RUN_LEASE_MS, undefined, now, checkout);
					return {
						note: `${holders(overlapping)} changing ${subject} in another worktree too, so merging the two may clash; ${asking} if the change is the same.`,
					};
				}
				if (here.length > 0) {
					for (const one of here) {
						told.add(key(one));
						tell(
							one.holder,
							one,
							claimsCheckout(one.lease)
								? `${peer.signature} reached for ${subject}, in the checkout this peer rewrote. It was told who did, and may go ahead beside this peer.`
								: `${peer.signature} reached for ${subject}, which this peer is changing. It was told who is, and may go ahead beside this peer.`,
						);
					}
					const rewrote = here.filter(({ lease }) => claimsCheckout(lease));
					const changing = here.filter(({ lease }) => !claimsCheckout(lease));
					const said = [
						changing.length > 0
							? `${holders(changing)} changing ${subject}. Two peers changing one file risk a conflict, so look at what is there first, or ${asking}.`
							: "",
						...rewrote.map(
							(one) =>
								`${holders([one])} ${changingText([one.lease])} in ${one.lease.subject}, so what is there may not be what this peer read: look at it first, or ${asking}.`,
						),
					].filter(Boolean);
					return {
						stop: `Not changed yet: ${said.join(" ")} Reaching for it again goes ahead beside them; they have been told.`,
					};
				}
			}
			own.take("change", subject, RUN_LEASE_MS, undefined, now, checkout);
			return undefined;
		},

		async rewrite(command, cwd) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return undefined;
			const found = rewriteIn(command, cwd);
			if (!found) return undefined;
			const now = Date.now();
			const { checkout } = found;
			const run = cut(found.command);
			// Asked every time, not only before the first: what another peer
			// changed since this peer last rewrote it is what a rewrite loses.
			const overlapping = await untold(
				othersIn(at.board.all(), peer.session, checkout, now),
			);
			if (overlapping.length > 0) {
				const byHolder = new Map<string, typeof overlapping>();
				for (const one of overlapping) {
					told.add(key(one));
					byHolder.set(one.session, [
						...(byHolder.get(one.session) ?? []),
						one,
					]);
				}
				const each = [...byHolder.values()].map((held) => {
					const [first] = held;
					if (first) {
						tell(
							first.holder,
							first,
							`${peer.signature} is about to run \`${run}\` in ${checkout}, which rewrites its files while this peer is ${changingText(held.map(({ lease }) => lease))}. It was told, and running it again goes ahead.`,
						);
					}
					return `${holders(held.slice(0, 1))} ${changingText(held.map(({ lease }) => lease))}`;
				});
				return `Not run yet: \`${run}\` rewrites the files of ${checkout}, where ${each.join("; and ")}. What they changed could be lost or switched out from under them, so look first, or ${asking}. Running it again goes ahead; they have been told.`;
			}
			if (!found.catchesUp) {
				own.take("change", checkout, RUN_LEASE_MS, run, now, checkout);
			}
			return undefined;
		},

		answering(messages) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return;
			const self = { addresses: peer.addresses, ...senderIdentity() };
			for (const message of messages) {
				// One that crossed from another realm is answered nowhere here.
				if (
					message.intent === "question" &&
					message.fromRealm === undefined &&
					!sentBy(message, self)
				) {
					own.take("answer", message.id, RUN_LEASE_MS, cut(message.text));
				}
			}
		},

		stillAnswering() {
			const own = at.own();
			if (!own) return;
			const now = Date.now();
			for (const lease of own.leases) {
				if (lease.kind === "answer" && isCurrent(lease, now)) {
					own.take("answer", lease.subject, RUN_LEASE_MS, lease.why, now);
				}
			}
		},

		async answeredBy(message) {
			const peer = at.peer();
			if (!peer) return undefined;
			const held = othersOn(
				at.board.all(),
				peer.session,
				"answer",
				message.id,
				Date.now(),
			);
			if (held.length === 0) return undefined;
			const { present } = await standing();
			const answerer = held
				.map((one) => present.get(one.session))
				.find((one) => one !== undefined);
			return answerer?.addresses[0];
		},

		sent(message) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return;
			const now = Date.now();
			if (message.intent === "hold") {
				own.take("hold", message.id, MOST_HOLD_MS, cut(message.text), now);
			}
			// Answering or replacing its own hold is how a holder ends it.
			for (const ended of [message.re, message.supersedes]) {
				if (ended !== undefined && own.held("hold", ended, now)) {
					own.release("hold", ended);
				}
			}
			// Ending another's hold on the person's word waits on nothing.
			if (message.re === undefined || message.endsHold) return;
			const hold = at.transport.read(message.re);
			const self = { addresses: peer.addresses, ...senderIdentity() };
			if (hold?.intent !== "hold" || sentBy(hold, self)) return;
			const left = standsUntil(hold) - now;
			if (left > 0) own.take("wait", hold.id, left, cut(message.text), now);
		},

		ended(message) {
			const own = at.own();
			if (!own) return undefined;
			const byPerson = (ref: string) =>
				message.endsHold === true && ref === message.re;
			// A hold the person ended is its holder's no longer.
			if (
				message.re !== undefined &&
				byPerson(message.re) &&
				own.held("hold", message.re, Date.now())
			) {
				own.release("hold", message.re);
			}
			for (const ref of [message.re, message.supersedes]) {
				if (ref === undefined) continue;
				const wait = own.leases.find(
					(lease) => lease.kind === "wait" && lease.subject === ref,
				);
				const hold = wait ? at.transport.read(ref) : undefined;
				if (!wait || !hold) continue;
				if (!mayReplace(message, hold) && !byPerson(ref)) continue;
				own.release("wait", ref);
				// A hold replaced by another hold still holds: the wait moves to it.
				if (message.supersedes === ref && message.intent === "hold") {
					const left = standsUntil(message) - Date.now();
					if (left > 0) own.take("wait", message.id, left, wait.why);
					return undefined;
				}
				return {
					hold,
					how: byPerson(ref)
						? `the person said it is over: "${cut(message.text)}"`
						: `its holder said "${cut(message.text)}"`,
					said: true,
					...(wait.why !== undefined ? { why: wait.why } : {}),
				};
			}
			return undefined;
		},

		async lapsed(now = Date.now()) {
			const own = at.own();
			if (!own) return [];
			const waits = own.leases.filter((lease) => lease.kind === "wait");
			if (waits.length === 0) return [];
			const { present, gone } = await standing();
			const booted = at.booted?.();
			const ends: HoldEnd[] = [];
			for (const wait of waits) {
				const hold = at.transport.read(wait.subject);
				// A holder restored after a reboot answers at its old address,
				// so it is not gone, but what it held off was the machine's.
				const how = !isCurrent(wait, now)
					? "it has stood two hours, as long as a hold lasts"
					: hold && booted !== undefined && Date.parse(hold.at) < booted
						? "the machine has restarted since it was sent"
						: hold && heldByGone(hold.from, present, gone)
							? "its holder has ended"
							: undefined;
				if (!how) continue;
				// Only the look that releases the wait tells it. Looks overlap
				// across the census read above, and another may have ended it
				// since this one listed it.
				if (!own.release("wait", wait.subject)) continue;
				if (hold) {
					ends.push({
						hold,
						how,
						said: false,
						...(wait.why !== undefined ? { why: wait.why } : {}),
					});
				}
			}
			return ends;
		},

		forgetEarlierBoots() {
			const own = at.own();
			const booted = at.booted?.();
			if (!own || booted === undefined) return;
			for (const lease of own.leases) {
				if (lease.kind !== "wait" && Date.parse(lease.since) < booted) {
					own.release(lease.kind, lease.subject);
				}
			}
		},

		async heavy(event) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return undefined;
			if ("release" in event) {
				own.release("heavy", event.release);
				return undefined;
			}
			const { subject, why, ms, quiet } = event.take;
			const now = Date.now();
			const fresh = own.held("heavy", subject, now) === undefined;
			own.take(
				"heavy",
				subject,
				Math.min(ms ?? HEAVY_MS, MOST_HOLD_MS),
				why,
				now,
			);
			if (!fresh || quiet === true || at.queueKept?.()) return undefined;
			const overlapping = await untold(
				othersOn(at.board.all(), peer.session, "heavy", subject, now),
			);
			if (overlapping.length === 0) return undefined;
			for (const one of overlapping) {
				told.add(key(one));
				tell(
					one.holder,
					one,
					`${peer.signature} started ${heavySaid(subject)} too${why ? ` (${why})` : ""}, beside this peer's.`,
				);
			}
			return `${holders(overlapping)} running ${heavySaid(subject)} already, so both now run on this machine at once. If that is too much for it, hold yours or ${asking}; they have been told.`;
		},
	};
}

/** When a hold stops standing, however long its holder is there. */
function standsUntil(hold: Pick<Message, "at">): number {
	return Date.parse(hold.at) + MOST_HOLD_MS;
}

/** Whether the peer signing with this address has ended, by the census. */
function heldByGone(
	address: string,
	present: ReadonlyMap<string, Presence>,
	gone: readonly Presence[],
): boolean {
	const answers = (one: Presence) => one.addresses.includes(address);
	return (
		gone.some(answers) && ![...present.values()].some((one) => answers(one))
	);
}

/**
 * Whether a change lease is held in another checkout than this one: a
 * lease that names none, from an older harness, counts as this one, so
 * it still stops the edit.
 */
function inAnotherCheckout(lease: Lease, checkout: string | undefined) {
	return (
		checkout !== undefined &&
		lease.checkout !== undefined &&
		lease.checkout !== checkout
	);
}

/** Who holds these, for the peer reaching: "5GV2AH (since 00:31, working on x) is". */
function holders(held: readonly (Held & { holder: Presence })[]): string {
	const each = held.map(
		({ holder, lease }) =>
			`${holder.addresses[0]} (since ${clock({ at: lease.since })}${holder.worksOn ? `, working on ${cut(holder.worksOn)}` : ""})`,
	);
	return `${each.join(" and ")} ${each.length === 1 ? "is" : "are"}`;
}

/**
 * What a peer's changes in one checkout are, to follow "is". A holder
 * writes its why as it likes, so it is said on one line and its
 * backticks as quotes, which can't close the code span it is said in.
 */
function changingText(leases: readonly Lease[]): string {
	const files = leases.filter((lease) => !claimsCheckout(lease));
	const shown = files.slice(0, 3).map((lease) => oneLine(lease.subject));
	const more = files.length - shown.length;
	return [
		files.length > 0
			? `changing ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
			: "",
		...leases
			.filter(claimsCheckout)
			.map((lease) =>
				lease.why
					? `working on what \`${oneLine(lease.why).replaceAll("`", "'")}\` left`
					: "working on all of them",
			),
	]
		.filter(Boolean)
		.join(", and ");
}

/** What an edit meets, said to pi: a stop before it runs, or a note after. */
export interface EditNotes {
	/** What the edit's tool_call answers: a block, or nothing, keeping a note. */
	met(
		toolCallId: string,
		reached: Reached | undefined,
	): { block: true; reason: string } | undefined;
	/** The edit's result content with its note added, when one was kept. */
	noted<T>(
		toolCallId: string,
		content: readonly T[],
	): (T | { type: "text"; text: string })[] | undefined;
}

/**
 * The notes edits' results carry, kept by call from when the edit is let
 * through until its result comes back, so an edit that overlaps a peer
 * in another worktree runs at once and is told of it in the same turn.
 */
export function createEditNotes(): EditNotes {
	const notes = new Map<string, string>();
	return {
		met(toolCallId, reached) {
			if (reached === undefined) return undefined;
			if ("stop" in reached) return { block: true, reason: reached.stop };
			notes.set(toolCallId, reached.note);
			return undefined;
		},
		noted(toolCallId, content) {
			const note = notes.get(toolCallId);
			if (note === undefined) return undefined;
			notes.delete(toolCallId);
			return [...content, { type: "text", text: note }];
		},
	};
}

/** A message's words, cut to what a lease keeps. */
function cut(text: string): string {
	const one = oneLine(text);
	return one.length > WHY_CHARS ? `${one.slice(0, WHY_CHARS)}...` : one;
}
