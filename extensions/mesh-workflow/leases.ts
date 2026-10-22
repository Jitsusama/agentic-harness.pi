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
 */

import { answeringTo } from "../../lib/mesh/address.ts";
import { homeOf } from "../../lib/mesh/group.ts";
import {
	type Board,
	changeOf,
	claimsCheckout,
	HEAVY_MS,
	type Held,
	type Holding,
	heavyWorkIn,
	isCurrent,
	type Lease,
	type LeaseEvent,
	MOST_HOLD_MS,
	type OwnLeases,
	othersIn,
	othersOn,
	ownerOf,
	RUN_LEASE_MS,
	rewriteIn,
} from "../../lib/mesh/lease.ts";
import { census } from "../../lib/mesh/liveness.ts";
import { clock, type Message, shortId } from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import type { Presence, Presences } from "../../lib/mesh/presence.ts";
import { mayReplace, sentBy } from "../../lib/mesh/thread.ts";
import type { Transport } from "../../lib/mesh/transport.ts";

/** How much of a message a lease keeps as what it is for. */
const WHY_CHARS = 120;

/** A hold this peer waited on that is over, and how it ended. */
export interface HoldEnd {
	readonly hold: Message;
	readonly how: string;
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
}

export interface Leasing {
	/**
	 * Before this peer changes a file: nothing when it may, or why not
	 * yet, once, when another peer is changing it.
	 */
	reach(path: string, cwd: string): Promise<string | undefined>;
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
}

export function createLeasing(at: LeaseSurroundings): Leasing {
	const asking = at.asking ?? "ask with mesh_send";
	// Each overlap is told once: a lease another peer took is known by its
	// holder and when it was taken, so a new run's claim is told again.
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

	const tell = (holder: Presence, text: string) => {
		const peer = at.peer();
		const address = holder.addresses[0];
		if (!peer || !address) return;
		at.sent(
			at.transport.send({
				from: peer.signature,
				to: [homeOf(address)],
				intent: "fyi",
				text,
				pid: process.pid,
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
				if (overlapping.length > 0) {
					for (const one of overlapping) {
						told.add(key(one));
						tell(
							one.holder,
							claimsCheckout(one.lease)
								? `${peer.signature} reached for ${subject}, in the checkout this peer rewrote. It was told who did, and may go ahead beside this peer.`
								: `${peer.signature} reached for ${subject}, which this peer is changing. It was told who is, and may go ahead beside this peer.`,
						);
					}
					const rewrote = overlapping.filter(({ lease }) =>
						claimsCheckout(lease),
					);
					const changing = overlapping.filter(
						({ lease }) => !claimsCheckout(lease),
					);
					const said = [
						changing.length > 0
							? `${holders(changing)} changing ${subject}. Two peers changing one file risk a conflict, so look at what is there first, or ${asking}.`
							: "",
						...rewrote.map(
							(one) =>
								`${holders([one])} ${changingText([one.lease])} in ${one.lease.subject}, so what is there may not be what this peer read: look at it first, or ${asking}.`,
						),
					].filter(Boolean);
					return `Not changed yet: ${said.join(" ")} Reaching for it again goes ahead beside them; they have been told.`;
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
							`${peer.signature} is about to run \`${run}\` in ${checkout}, which rewrites its files while this peer is ${changingText(held.map(({ lease }) => lease))}. It was told, and running it again goes ahead.`,
						);
					}
					return `${holders(held.slice(0, 1))} ${changingText(held.map(({ lease }) => lease))}`;
				});
				return `Not run yet: \`${run}\` rewrites the files of ${checkout}, where ${each.join("; and ")}. What they changed could be lost or switched out from under them, so look first, or ${asking}. Running it again goes ahead; they have been told.`;
			}
			own.take("change", checkout, RUN_LEASE_MS, run, now, checkout);
			return undefined;
		},

		answering(messages) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return;
			const self = { addresses: peer.addresses, pid: process.pid };
			for (const message of messages) {
				if (message.intent === "question" && !sentBy(message, self)) {
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
			if (message.re === undefined) return;
			const hold = at.transport.read(message.re);
			const self = { addresses: peer.addresses, pid: process.pid };
			if (hold?.intent !== "hold" || sentBy(hold, self)) return;
			const left = standsUntil(hold) - now;
			if (left > 0) own.take("wait", hold.id, left, cut(message.text), now);
		},

		ended(message) {
			const own = at.own();
			if (!own) return undefined;
			for (const ref of [message.re, message.supersedes]) {
				if (ref === undefined) continue;
				const wait = own.leases.find(
					(lease) => lease.kind === "wait" && lease.subject === ref,
				);
				const hold = wait ? at.transport.read(ref) : undefined;
				if (!wait || !hold || !mayReplace(message, hold)) continue;
				own.release("wait", ref);
				// A hold replaced by another hold still holds: the wait moves to it.
				if (message.supersedes === ref && message.intent === "hold") {
					const left = standsUntil(message) - Date.now();
					if (left > 0) own.take("wait", message.id, left, wait.why);
					return undefined;
				}
				return {
					hold,
					how: `its holder said "${cut(message.text)}"`,
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
			const ends: HoldEnd[] = [];
			for (const wait of waits) {
				const hold = at.transport.read(wait.subject);
				const how = !isCurrent(wait, now)
					? "it has stood two hours, as long as a hold lasts"
					: hold && heldByGone(hold.from, present, gone)
						? "its holder has ended"
						: undefined;
				if (!how) continue;
				own.release("wait", wait.subject);
				if (hold) {
					ends.push({
						hold,
						how,
						...(wait.why !== undefined ? { why: wait.why } : {}),
					});
				}
			}
			return ends;
		},

		async heavy(event) {
			const own = at.own();
			const peer = at.peer();
			if (!own || !peer) return undefined;
			if ("release" in event) {
				own.release("heavy", event.release);
				return undefined;
			}
			const { subject, why, ms } = event.take;
			const now = Date.now();
			const fresh = own.held("heavy", subject, now) === undefined;
			own.take(
				"heavy",
				subject,
				Math.min(ms ?? HEAVY_MS, MOST_HOLD_MS),
				why,
				now,
			);
			if (!fresh) return undefined;
			const overlapping = await untold(
				othersOn(at.board.all(), peer.session, "heavy", subject, now),
			);
			if (overlapping.length === 0) return undefined;
			for (const one of overlapping) {
				told.add(key(one));
				tell(
					one.holder,
					`${peer.signature} started heavy work on ${subject} too${why ? ` (${why})` : ""}, beside this peer's.`,
				);
			}
			return `Heavy work on ${subject}: ${holders(overlapping)} running it already, so both now run on this machine at once. If that is too much for it, hold yours or ${asking}; they have been told.`;
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

/** Who holds these, for the peer reaching: "5GV2AH (since 00:31, working on x) is". */
function holders(held: readonly (Held & { holder: Presence })[]): string {
	const each = held.map(
		({ holder, lease }) =>
			`${holder.addresses[0]} (since ${clock({ at: lease.since })}${holder.worksOn ? `, working on ${cut(holder.worksOn)}` : ""})`,
	);
	return `${each.join(" and ")} ${each.length === 1 ? "is" : "are"}`;
}

/** What a peer's changes in one checkout are, to follow "is". */
function changingText(leases: readonly Lease[]): string {
	const files = leases.filter((lease) => !claimsCheckout(lease));
	const shown = files.slice(0, 3).map((lease) => lease.subject);
	const more = files.length - shown.length;
	return [
		files.length > 0
			? `changing ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
			: "",
		...leases
			.filter(claimsCheckout)
			.map((lease) =>
				lease.why
					? `working on what \`${lease.why}\` left`
					: "working on all of them",
			),
	]
		.filter(Boolean)
		.join(", and ");
}

/** The leases of the peers still there, as mesh_groups lists them. */
export function leasesText(
	board: readonly Holding[],
	present: readonly Presence[],
	now: number = Date.now(),
): string {
	const lines = present.flatMap((one) => {
		// Its hands' leases are its own, as they were claimed.
		const leases = board
			.filter((holding) => ownerOf(holding) === one.session)
			.flatMap((holding) => holding.leases)
			.filter((lease) => isCurrent(lease, now));
		return leases.length > 0 && one.addresses[0]
			? [`${one.addresses[0]}: ${describeAll(leases)}`]
			: [];
	});
	return lines.length > 0 ? `\nLeases:\n${lines.join("\n")}` : "";
}

/** A peer's leases in a phrase, its changes counted past the first few. */
function describeAll(leases: readonly Lease[]): string {
	const changes = leases.filter(
		(lease) => lease.kind === "change" && !claimsCheckout(lease),
	);
	const shown = changes.slice(0, 3).map((lease) => lease.subject);
	const more = changes.length - shown.length;
	const changing = [
		...leases
			.filter(claimsCheckout)
			.map(
				(lease) =>
					`rewrote the files of ${lease.subject}${lease.why ? ` (${lease.why})` : ""}`,
			),
		...(changes.length > 0
			? [`changing ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`]
			: []),
	];
	const rest = leases
		.filter((lease) => lease.kind !== "change")
		.map((lease) => {
			const id = `[${shortId({ id: lease.subject })}]`;
			const why = lease.why ? ` (${lease.why})` : "";
			switch (lease.kind) {
				case "answer":
					return `answering ${id}${why}`;
				case "hold":
					return `holding ${id} until ${clock({ at: lease.until })}${why}`;
				case "wait":
					return `waiting on ${id}${why}`;
				default:
					return `running heavy work on ${lease.subject}${why}`;
			}
		});
	return [...changing, ...rest].join("; ");
}

/** How a bash call says it handed its command to a job. */
const HANDED_OFF = /in the background as job \S+/;

/** A command's first line, as a lease says what it is for. */
export function commandLine(command: string): string {
	const first = command.trim().split("\n")[0] ?? "";
	return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/**
 * The heavy shell commands running, by call, so work two calls share is
 * given up only when the last of them ends. A call's work is over when
 * it answers, unless it handed its command to a job, which runs on past
 * the answer until the job says it has ended.
 */
export interface HeavyCalls {
	/** A bash call is starting: the heavy work it runs, if any. */
	called(toolCallId: string, command: unknown): string | undefined;
	/** A call answered, with these parts. */
	answered(toolCallId: string, content: readonly unknown[]): void;
	/** A job a call handed off has ended. */
	finished(toolCallId: string): void;
	/** Forget every call, as a session ending does. */
	clear(): void;
}

export function createHeavyCalls(
	heavy: (event: LeaseEvent) => void,
	why: (command: string) => string = commandLine,
): HeavyCalls {
	const calls = new Map<string, string>();
	const ended = (toolCallId: string) => {
		const subject = calls.get(toolCallId);
		if (subject === undefined) return;
		calls.delete(toolCallId);
		if (![...calls.values()].includes(subject)) heavy({ release: subject });
	};
	return {
		called(toolCallId, command) {
			const subject =
				typeof command === "string" ? heavyWorkIn(command) : undefined;
			if (subject === undefined || typeof command !== "string") {
				return undefined;
			}
			calls.set(toolCallId, subject);
			heavy({ take: { subject, why: why(command) } });
			return subject;
		},
		answered(toolCallId, content) {
			const handedOff = content.some(
				(part) =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					HANDED_OFF.test(String((part as { text?: unknown }).text)),
			);
			if (!handedOff) ended(toolCallId);
		},
		finished: ended,
		clear: () => calls.clear(),
	};
}

/** A message's words, cut to what a lease keeps. */
function cut(text: string): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > WHY_CHARS ? `${one.slice(0, WHY_CHARS)}...` : one;
}
