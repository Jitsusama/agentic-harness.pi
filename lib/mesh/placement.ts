/**
 * Where a mycelium node places work: the needs work says in the node's
 * own words, `kind=value` or the bare `cloud`, and the node's answer read
 * as the machine it chose or its reasons for choosing none.
 *
 * The node chooses among the machines its realm links by what each says
 * it is, and ranks them by what each is going through (on battery, short
 * of memory, its disk filling). This only carries the words there and
 * back; it judges nothing itself.
 */

import { isRecord } from "../internal/record.ts";
import { NOTHING_SHOWN, shownLines } from "./shown-line.ts";

/**
 * The most characters quoted of a placement reply this harness can't
 * read, as it shows (shownLines), since it may relay a peer's words.
 */
const MOST_UNREAD = 200;

/**
 * The most characters quoted of one word a peer's miss carries (its
 * machine's name, a taint's why or key), as it shows, since each is the
 * peer's own and is read out as Joel's to judge.
 */
const MOST_PEER_SAID = 120;

/** A peer's own word, as it shows, or `?` where nothing of it does. */
function peerSaid(word: string): string {
	return shownLines(word, MOST_PEER_SAID) || "?";
}

/** What a machine can be, as a node's placement names it. */
export type NeedKind =
	| "machine"
	| "system"
	| "arch"
	| "reach"
	| "accelerator"
	| "tool";

/**
 * Something work needs a machine to be: a kind and its value, such as
 * `reach=home`, or `cloud` alone, any machine a provider made.
 */
export type Need =
	| { readonly kind: NeedKind; readonly value: string }
	| { readonly kind: "cloud" };

/** A need as the node reads it: `{"reach": "home"}`, or `"cloud"`. */
export type NeedOnTheWire = Readonly<Record<string, string>> | "cloud";

const KINDS: readonly NeedKind[] = [
	"machine",
	"system",
	"arch",
	"reach",
	"accelerator",
	"tool",
];

/** The word for the one need with no value. */
const CLOUD = "cloud";

const ACCELERATORS = ["gpu", "npu"];

/** A need read from its words, or why the words aren't one. */
export type NeedRead =
	| { readonly ok: true; readonly need: Need }
	| { readonly ok: false; readonly reason: string };

/**
 * Reads `word`, such as `reach=home`, `tool=gcloud` or `cloud`, as
 * mycelium's `--need` takes it.
 */
export function needFrom(word: string): NeedRead {
	if (word === CLOUD) return { ok: true, need: { kind: "cloud" } };
	const at = word.indexOf("=");
	const kind = KINDS.find((each) => each === word.slice(0, at));
	const value = word.slice(at + 1);
	if (at < 0 || kind === undefined || value === "") {
		return {
			ok: false,
			reason: `"${word}" is not a need: ${CLOUD}, or kind=value, the kind one of ${KINDS.join(", ")}`,
		};
	}
	if (kind === "accelerator" && !ACCELERATORS.includes(value)) {
		return {
			ok: false,
			reason: `"${word}" names no accelerator: gpu or npu`,
		};
	}
	return { ok: true, need: { kind, value } };
}

/** A need as the node reads it: `{"reach": "home"}`, or `"cloud"`. */
export function needOnTheWire(need: Need): NeedOnTheWire {
	return "value" in need ? { [need.kind]: need.value } : CLOUD;
}

/** A need in its words again. */
export function needWords(need: Need): string {
	return "value" in need ? `${need.kind}=${need.value}` : CLOUD;
}

/** Whether `need` names one machine other than `machine`. */
export function namesOtherMachine(need: Need, machine: string): boolean {
	return need.kind === "machine" && "value" in need && need.value !== machine;
}

/** Where the node placed work, or why it placed it nowhere. */
export type PlaceAnswer =
	| { readonly ok: true; readonly machine: string }
	| { readonly ok: false; readonly reason: string };

/** A placement's answer read: the machine chosen, or the node's reasons. */
export function placedFrom(line: string): PlaceAnswer {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Fall through to the answer this reader can't read.
	}
	if (isRecord(reply) && typeof reply.Err === "string") {
		return { ok: false, reason: withOldNodeSaid(reply.Err) };
	}
	const placement =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Placement : undefined;
	if (isRecord(placement)) {
		const { placed, pending, refused } = placement;
		if (isRecord(placed) && typeof placed.machine === "string") {
			return { ok: true, machine: placed.machine };
		}
		if (isRecord(refused)) {
			return {
				ok: false,
				reason: `no machine takes it: ${missesIn(refused.misses)}`,
			};
		}
		if (isRecord(pending)) {
			return {
				ok: false,
				reason: `only a machine out of reach would take it: ${missesIn(pending.misses)}`,
			};
		}
	}
	return {
		ok: false,
		reason: `the node answered what this harness can't read: ${shownLines(line, MOST_UNREAD) || NOTHING_SHOWN}`,
	};
}

/** How a node too old for a need word says it can't read the request. */
const UNKNOWN_NEW_NEED = /unknown variant `(?:cloud|tool)`/;

/**
 * The node's refusal, said with why when it is a node older than the
 * words `cloud` and `tool=`, which would otherwise read as a typo.
 */
function withOldNodeSaid(refusal: string): string {
	return UNKNOWN_NEW_NEED.test(refusal)
		? `${refusal} (the node is older than the needs cloud and tool=)`
		: refusal;
}

/** Each machine passed over and why, as a sentence's tail. */
function missesIn(misses: unknown): string {
	if (!Array.isArray(misses) || misses.length === 0) {
		return "the realm has no machine";
	}
	return misses
		.map((miss) => {
			if (!isRecord(miss) || typeof miss.machine !== "string") return "?";
			const because = Array.isArray(miss.because) ? miss.because : [];
			return `${peerSaid(miss.machine)} ${because.map(reasonIn).join(" and ")}`;
		})
		.join("; ");
}

/** One of the node's reasons a machine didn't take work, in words. */
function reasonIn(because: unknown): string {
	if (because === "ranked") return "ranked lower";
	if (because === "unreachable") return "is out of reach";
	if (because === "unheard") return "hasn't said its room lately";
	if (!isRecord(because)) return "says something this harness can't read";
	if (typeof because.leaves_first === "string") {
		return `leaves at ${because.leaves_first}, before the work ends`;
	}
	// jiff writes a duration as ISO 8601, such as PT1H, said as it came.
	if (typeof because.lives_only === "string") {
		return `would live only ${because.lives_only}, ending before the work`;
	}
	if (typeof because.full === "number") {
		return `holds the ${because.full} sessions it holds at most`;
	}
	if (because.lacks === CLOUD) return "isn't a cloud machine";
	if (because.lacks !== undefined) return `lacks ${wordsOf(because.lacks)}`;
	if (because.unknown !== undefined) {
		return `hasn't said whether it has ${wordsOf(because.unknown)}`;
	}
	if (because.refuses !== undefined)
		return `refuses it (${whyOf(because.refuses)})`;
	if (because.rather_not !== undefined) {
		return `would rather not (${whyOf(because.rather_not)})`;
	}
	return "says something this harness can't read";
}

/** A need the node sent back, `{"reach": "home"}` or `"cloud"`, in its words. */
function wordsOf(need: unknown): string {
	if (need === CLOUD) return "a cloud machine";
	if (!isRecord(need)) return "?";
	return Object.entries(need)
		.map(([kind, value]) => `${kind}=${String(value)}`)
		.join(", ");
}

/** A taint the node sent back, by why it was set. */
function whyOf(taint: unknown): string {
	if (!isRecord(taint)) return "?";
	if (typeof taint.why === "string") return peerSaid(taint.why);
	return typeof taint.key === "string" ? peerSaid(taint.key) : "?";
}
