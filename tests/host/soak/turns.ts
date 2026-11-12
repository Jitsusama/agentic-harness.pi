/**
 * The soak's script: what each conversation is told, turn by turn, and
 * how its turns fall into viewer visits. The same for every run of the
 * same sizes, so the host and plain pi are told exactly the same things
 * and their records compare. Each prompt carries a tag the provider
 * answers by and a turn ends on, and asks for one kind of turn.
 */

/** What a turn asks the provider for. */
export type TurnKind = "echo" | "read" | "bash" | "job" | "long";

/** One turn of one conversation. */
export interface Turn {
	/** The conversation it belongs to, from 0. */
	readonly conversation: number;
	/** Its place in its conversation, from 0. */
	readonly index: number;
	/** Its tag, unique across the run, such as `c3-t41`. */
	readonly tag: string;
	readonly kind: TurnKind;
	/** What it is typed or sent as. */
	readonly prompt: string;
}

/** A run of turns one viewer types, attached for all of them. */
export interface Visit {
	readonly turns: readonly Turn[];
	/** Whether a second viewer attaches after its first turn and leaves. */
	readonly joined: boolean;
}

/** How often each kind comes, out of {@link CYCLE} turns; the rest echo. */
const EVERY: Readonly<Record<Exclude<TurnKind, "echo">, number>> = {
	read: 0,
	bash: 3,
	job: 7,
	long: 11,
};

/** The length of the kinds' cycle, a prime so conversations drift apart. */
const CYCLE = 17;

/** The shortest and longest visits, in turns. */
const SHORTEST_VISIT = 2;
const LONGEST_VISIT = 8;

/** A second viewer joins every this many visits. */
const JOINED_EVERY = 3;

/** The prompt's shape, which the provider reads its tag and kind from. */
const PROMPT = /soak (c\d+-t\d+) (echo|read|bash|job|long)\b/;

/** The tag a turn's final answer ends with, which a wait looks for. */
export function acknowledged(tag: string): string {
	return `ack ${tag}.`;
}

/** The tag and kind a prompt asks for, or nothing when it isn't the soak's. */
export function asked(
	words: string,
): { readonly tag: string; readonly kind: TurnKind } | undefined {
	const found = PROMPT.exec(words);
	const [, tag, kind] = found ?? [];
	if (tag === undefined || !isKind(kind)) return undefined;
	return { tag, kind };
}

function isKind(kind: string | undefined): kind is TurnKind {
	return (
		kind === "echo" ||
		kind === "read" ||
		kind === "bash" ||
		kind === "job" ||
		kind === "long"
	);
}

/** Conversation `conversation`'s `count` turns, in order. */
export function turnsOf(conversation: number, count: number): Turn[] {
	return Array.from({ length: count }, (_, index) => {
		const tag = `c${conversation}-t${index}`;
		const kind = kindAt((conversation * 5 + index) % CYCLE);
		return {
			conversation,
			index,
			tag,
			kind,
			prompt: `soak ${tag} ${kind}, please`,
		};
	});
}

function kindAt(place: number): TurnKind {
	for (const [kind, at] of Object.entries(EVERY))
		if (at === place && isKind(kind)) return kind;
	return "echo";
}

/** A conversation's turns as viewer visits, of two to eight turns each. */
export function visitsOf(turns: readonly Turn[]): Visit[] {
	const visits: Visit[] = [];
	let at = 0;
	while (at < turns.length) {
		const drift = (turns[at]?.conversation ?? 0) + visits.length;
		const span =
			SHORTEST_VISIT + (drift % (LONGEST_VISIT - SHORTEST_VISIT + 1));
		visits.push({
			turns: turns.slice(at, at + span),
			joined: visits.length % JOINED_EVERY === JOINED_EVERY - 1,
		});
		at += span;
	}
	return visits;
}

/**
 * How many of a conversation's `count` turns are done at each of the
 * run's `checkpoints`, where every conversation stops for a weighing:
 * spread evenly, the last at its end, so a short conversation and the
 * busiest reach each checkpoint the same share of the way through.
 */
export function checkpointsOf(count: number, checkpoints: number): number[] {
	if (checkpoints <= 0) return [];
	return Array.from({ length: checkpoints }, (_, n) =>
		Math.round((count * (n + 1)) / checkpoints),
	);
}
