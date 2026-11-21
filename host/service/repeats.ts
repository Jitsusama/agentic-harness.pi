/**
 * The starts a host was asked for, by request id, so a requester that
 * asks again after its answer was lost, as a spawn that timed out does,
 * gets the answer the first ask gets rather than a second conversation.
 * A start that fails is forgotten, so its retry starts anew; one asked
 * again under the same id but for something else is refused.
 */
import { hostRefusal } from "./dispatch.ts";

/**
 * How long, in ms, a settled start's answer is kept for a repeat: long
 * past a spawn's patience and a person's retry, and short enough that
 * the host keeps only a few.
 */
export const REPEAT_WINDOW_MS = 15 * 60_000;

/** What a repeat is told by, and what it is matched against. */
export type Repeatable = {
	readonly id: string;
	readonly [field: string]: unknown;
};

/** The starts a host remembers by request id. */
export interface Repeats {
	/**
	 * The answer to `request`: the one under way or given for its id when
	 * the request is the same, else what `start` answers. A request whose
	 * id was used for another is refused.
	 */
	answer(request: Repeatable, start: () => Promise<unknown>): Promise<unknown>;
}

interface Asked {
	readonly what: string;
	readonly answer: Promise<unknown>;
	/** When it settled, in ms; unset while it is under way. */
	settledAt?: number;
}

/** Remember starts for `windowMs` once settled, by the clock `now`. */
export function repeats(
	now: () => number = Date.now,
	windowMs = REPEAT_WINDOW_MS,
): Repeats {
	const asked = new Map<string, Asked>();

	// One under way is kept however long it takes, since its repeat
	// would otherwise start a second.
	function prune(at: number): void {
		for (const [id, one] of asked)
			if (one.settledAt !== undefined && at - one.settledAt > windowMs)
				asked.delete(id);
	}

	return {
		answer(request, start) {
			prune(now());
			const what = fingerprint(request);
			const before = asked.get(request.id);
			if (before) {
				if (before.what !== what)
					return Promise.reject(
						hostRefusal(
							"id_reused",
							`Request id ${request.id} was already used for another request; send a new id`,
						),
					);
				// Asked once already, so the answer it gets is that one's.
				return before.answer;
			}
			const answer = start();
			const one: Asked = { what, answer };
			asked.set(request.id, one);
			answer.then(
				() => {
					one.settledAt = now();
				},
				() => {
					// A failed start is forgotten, so asking again starts anew.
					if (asked.get(request.id) === one) asked.delete(request.id);
				},
			);
			return answer;
		},
	};
}

/**
 * What a request asks for, without its id or the host it expects, so a
 * repeat sent after a restart of the requester still matches; keys in
 * order, so two spellings of one request match. A requester keeping its
 * id across a retry compares by it too (spawn-pending.ts).
 */
export function fingerprint(request: Repeatable): string {
	const { id: _id, expectedHost: _expected, ...rest } = request;
	return JSON.stringify(rest, (_key, value: unknown) =>
		isPlain(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
				)
			: value,
	);
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
