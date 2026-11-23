/**
 * The starts a host was asked for, by request id, so a requester that
 * asks again after its answer was lost, as a spawn that timed out does,
 * gets the answer the first ask gets rather than a second conversation.
 * A start that fails is forgotten, so its retry starts anew, and one
 * whose outcome no longer stands (its conversation ended) is too; one
 * asked again under the same id but for something else is refused.
 */
import { hostRefusal } from "./dispatch.ts";
import {
	fingerprint,
	REPEAT_WINDOW_MS,
	type Repeatable,
} from "./repeat-key.ts";

export { fingerprint, REPEAT_WINDOW_MS, type Repeatable };

/** The starts a host remembers by request id. */
export interface Repeats {
	/**
	 * The answer to `request`: the one under way or given for its id when
	 * the request is the same, else what `start` answers. A request whose
	 * id was used for another is refused.
	 */
	answer(request: Repeatable, start: () => Promise<unknown>): Promise<unknown>;
}

/** How a start settled. */
export type Outcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: unknown };

interface Asked {
	readonly what: string;
	readonly answer: Promise<unknown>;
	/** When it settled, in ms; unset while it is under way. */
	settledAt?: number;
	/** How it settled; unset while it is under way. */
	outcome?: Outcome;
}

/** By default an answer stands and a failure doesn't. */
function answered(outcome: Outcome): boolean {
	return outcome.ok;
}

/**
 * Remember starts for `windowMs` once settled, by the clock `now`, for
 * as long as `stands` says how each settled still answers a repeat: a
 * conversation opened that has since ended doesn't, and a start that
 * failed but left its conversation held does. `heard` is told of each
 * repeat answered from memory, and whether its start was still under way.
 */
export function repeats(
	now: () => number = Date.now,
	windowMs = REPEAT_WINDOW_MS,
	stands: (outcome: Outcome) => boolean = answered,
	heard: (id: string, underWay: boolean) => void = () => undefined,
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
				// Asked once already, so the answer it gets is that one's, unless
				// what it opened has gone since.
				if (before.outcome === undefined || stands(before.outcome)) {
					heard(request.id, before.outcome === undefined);
					return before.answer;
				}
				asked.delete(request.id);
			}
			const answer = start();
			const one: Asked = { what, answer };
			asked.set(request.id, one);
			const settled = (outcome: Outcome): void => {
				one.outcome = outcome;
				one.settledAt = now();
				// One that no longer stands is forgotten, so asking again starts anew.
				if (!stands(outcome) && asked.get(request.id) === one)
					asked.delete(request.id);
			};
			answer.then(
				(value: unknown) => settled({ ok: true, value }),
				(error: unknown) => settled({ ok: false, error }),
			);
			return answer;
		},
	};
}
