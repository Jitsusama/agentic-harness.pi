// Ending a turn as pi says it to an extension that hears turns through lib/internal/session/turn-end.ts.

/** Fires an event at a stand-in pi's handlers, as its test does. */
export type Fire = (
	event: string,
	payload: unknown,
	ctx: unknown,
) => unknown | Promise<unknown>;

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The events the turn listener hears beside an extension's own. */
const SHARED = new Set(["message_end", "turn_start"]);

/**
 * For a stand-in pi that keeps one handler an event: on an event the
 * turn listener shares, `handler` runs after the one already there, as
 * pi runs both, rather than in its place.
 */
export function alongside(
	handlers: ReadonlyMap<string, Handler>,
	event: string,
	handler: Handler,
): Handler {
	const before = handlers.get(event);
	if (!before || !SHARED.has(event)) return handler;
	return async (payload, ctx) => {
		await before(payload, ctx);
		return handler(payload, ctx);
	};
}

/** A turn as a test gives it: its answer and its tool results. */
export interface TurnGiven {
	readonly message?: object;
	readonly toolResults?: readonly object[];
}

/**
 * End a turn as pi's loop says it: the answer's `message_end`, each tool
 * result's, then the next turn's `turn_start`, at which the turn's
 * observers hear it. With `boundary`, pi's `turn_end` comes before that
 * start, for a handler of the boundary that wants it.
 */
export async function endTurn(
	fire: Fire,
	turn: TurnGiven = {},
	ctx: unknown = {},
	options: { readonly boundary?: boolean } = {},
): Promise<void> {
	const message = { role: "assistant", ...turn.message };
	await fire("message_end", { message }, ctx);
	const toolResults = (turn.toolResults ?? []).map((result) => ({
		role: "toolResult",
		...result,
	}));
	for (const result of toolResults) {
		await fire("message_end", { message: result }, ctx);
	}
	if (options.boundary) {
		await fire("turn_end", { ...turn, message, toolResults }, ctx);
	}
	await fire("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
}
