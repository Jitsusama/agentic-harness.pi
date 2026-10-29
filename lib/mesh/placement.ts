/**
 * Where a mycelium node places work: the needs work says in the node's
 * own `kind=value` words, and the node's answer read as the machine it
 * chose or its reasons for choosing none.
 *
 * The node chooses among the machines its realm links by what each says
 * it is, and ranks them by what each is going through (on battery, short
 * of memory, its disk filling). This only carries the words there and
 * back; it judges nothing itself.
 */

import { isRecord } from "../internal/record.ts";

/** What a machine can be, as a node's placement names it. */
export type NeedKind = "machine" | "system" | "arch" | "reach" | "accelerator";

/** Something work needs a machine to be, such as `reach=home`. */
export interface Need {
	readonly kind: NeedKind;
	readonly value: string;
}

const KINDS: readonly NeedKind[] = [
	"machine",
	"system",
	"arch",
	"reach",
	"accelerator",
];

const ACCELERATORS = ["gpu", "npu"];

/** A need read from its words, or why the words aren't one. */
export type NeedRead =
	| { readonly ok: true; readonly need: Need }
	| { readonly ok: false; readonly reason: string };

/** Reads `word`, such as `reach=home`, as mycelium's `--need` takes it. */
export function needFrom(word: string): NeedRead {
	const at = word.indexOf("=");
	const kind = KINDS.find((each) => each === word.slice(0, at));
	const value = word.slice(at + 1);
	if (at < 0 || kind === undefined || value === "") {
		return {
			ok: false,
			reason: `"${word}" is not a need: kind=value, the kind one of ${KINDS.join(", ")}`,
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

/** A need as the node reads it: `{"reach": "home"}`. */
export function needOnTheWire(need: Need): Record<string, string> {
	return { [need.kind]: need.value };
}

/** A need in its words again. */
export function needWords(need: Need): string {
	return `${need.kind}=${need.value}`;
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
		return { ok: false, reason: reply.Err };
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
		reason: `the node answered what this harness can't read: ${line.slice(0, 200)}`,
	};
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
			return `${miss.machine} ${because.map(reasonIn).join(" and ")}`;
		})
		.join("; ");
}

/** One of the node's reasons a machine didn't take work, in words. */
function reasonIn(because: unknown): string {
	if (because === "ranked") return "ranked lower";
	if (because === "unreachable") return "is out of reach";
	if (!isRecord(because)) return "says something this harness can't read";
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

/** A need the node sent back, `{"reach": "home"}`, in its words. */
function wordsOf(need: unknown): string {
	if (!isRecord(need)) return "?";
	return Object.entries(need)
		.map(([kind, value]) => `${kind}=${String(value)}`)
		.join(", ");
}

/** A taint the node sent back, by why it was set. */
function whyOf(taint: unknown): string {
	if (!isRecord(taint)) return "?";
	return typeof taint.why === "string" ? taint.why : String(taint.key);
}
