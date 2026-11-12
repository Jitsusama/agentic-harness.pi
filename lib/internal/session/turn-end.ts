/**
 * One `turn_end` listener for every harness extension in a session.
 *
 * pi treats `turn_end` as a boundary its handlers may add entries at, so
 * it builds the whole context a handler could see (the branch copied
 * into a session of its own, projected and converted for the model)
 * once before the first handler and again after each one, whatever the
 * handler returned. The harness had nine, all of them only watching, so
 * every tool round on a 38 MB session held pi's main thread for 118 to
 * 237 ms of ten such builds, and keys typed then waited (12 November,
 * plan item 191; upstream closed the report, earendil-works/pi#10515).
 * One listener that hands the turn to each in turn makes it two builds.
 *
 * The handlers meet on the session's event bus, which every extension
 * in one session shares and no other session sees. The first to come
 * listens for the rest on a channel, and each later one offers itself
 * there; the bus calls its listeners synchronously, so an offer is
 * taken or not by the time `emit` returns, and one nobody took listens
 * itself. pi drops a runtime's bus subscriptions when a reload or a
 * session switch replaces it, and a failed load drops its own, so an
 * offer never reaches a listener that's gone. Without a bus, as in
 * some stand-ins, each handler listens itself.
 *
 * A handler here only watches: it can't add entries or ask to go on.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

/** What hears the end of a turn, and changes nothing pi does next. */
export type TurnEndHandler = (
	event: TurnEndEvent,
	ctx: ExtensionContext,
) => void | Promise<void>;

/** Where a later handler offers itself to the session's listener. */
const OFFERS = "agentic-harness.pi/turn-end/offer/v1";

interface Offer {
	readonly handler: TurnEndHandler;
	taken: boolean;
}

/**
 * Hand `handler` the end of each turn, through the one listener its
 * session's extensions share.
 */
export function onTurnEnd(pi: ExtensionAPI, handler: TurnEndHandler): void {
	const bus = busOf(pi);
	if (!bus) {
		pi.on("turn_end", handler);
		return;
	}
	const offer: Offer = { handler, taken: false };
	bus.emit(OFFERS, offer);
	if (offer.taken) return;
	const handlers: TurnEndHandler[] = [handler];
	bus.on(OFFERS, (data) => {
		if (!isOffer(data) || data.taken) return;
		data.taken = true;
		handlers.push(data.handler);
	});
	pi.on("turn_end", (event, ctx) => handTurn(handlers, event, ctx));
}

/** The session's event bus, where the stand-in has one. */
function busOf(pi: ExtensionAPI): ExtensionAPI["events"] | undefined {
	const bus: unknown = pi.events;
	if (typeof bus !== "object" || bus === null) return undefined;
	if (!("emit" in bus) || !("on" in bus)) return undefined;
	if (typeof bus.emit !== "function" || typeof bus.on !== "function") {
		return undefined;
	}
	return pi.events;
}

function isOffer(data: unknown): data is Offer {
	return (
		typeof data === "object" &&
		data !== null &&
		"handler" in data &&
		typeof data.handler === "function" &&
		"taken" in data &&
		typeof data.taken === "boolean"
	);
}

/**
 * Each handler in the order it came, as pi would call them: one that
 * fails doesn't keep the turn from the rest, and is said after them.
 */
async function handTurn(
	handlers: readonly TurnEndHandler[],
	event: TurnEndEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const failures: unknown[] = [];
	for (const handler of handlers) {
		try {
			await handler(event, ctx);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) {
		const said = failures.map((error) =>
			error instanceof Error ? error.message : String(error),
		);
		throw new Error(
			`${failures.length} turn_end handlers failed: ${said.join("; ")}`,
		);
	}
}
