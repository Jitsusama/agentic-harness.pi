/**
 * What will wake a session when what it waits on happens, asked over
 * pi's bus so the asker imports none of the extensions that know.
 *
 * A session that ends a run blocked rests until something gives it a
 * turn: a background job's report, the answer to a question it asked, a
 * hold it waits on ending, the person settling a Needs You item it
 * filed. Away mode asks before letting such a run rest, since a run
 * with none of these out sits until somebody happens by: from 8 to 10
 * November 20 did so for half an hour or more, 124 hours in all. Each
 * extension that keeps one of these adds a phrase for each it holds,
 * before `emit` returns.
 */

/** Asked on the bus; the payload is a {@link WakersAsk}. */
export const WAKERS_ASK = "session:wakers-ask:v1";

/** What {@link WAKERS_ASK} carries. */
export interface WakersAsk {
	/** The session asking about itself. */
	readonly session: string;
	/** What will wake it, each in a phrase, added to by whoever holds one. */
	readonly wakers: string[];
}

/** Whether a payload is a {@link WakersAsk}. */
export function isWakersAsk(data: unknown): data is WakersAsk {
	return (
		typeof data === "object" &&
		data !== null &&
		"session" in data &&
		typeof data.session === "string" &&
		"wakers" in data &&
		Array.isArray(data.wakers)
	);
}

/** The part of pi's bus asking needs. */
interface Bus {
	emit(channel: string, data: unknown): void;
}

/** Ask the bus what will wake `session`, with what the asker knows first. */
export function askWakers(
	bus: Bus,
	session: string,
	known: readonly string[] = [],
): string[] {
	const ask: WakersAsk = { session, wakers: [...known] };
	bus.emit(WAKERS_ASK, ask);
	return ask.wakers;
}
