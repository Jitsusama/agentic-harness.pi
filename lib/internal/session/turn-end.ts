/**
 * One listener for the end of a turn, for every harness extension in a
 * session, kept off pi's `turn_end` boundary unless one needs it.
 *
 * pi treats `turn_end` as a boundary its handlers may add entries at, so
 * while any handler is registered for it, it builds the whole context a
 * handler could see (the branch copied into a session of its own,
 * projected and converted for the model) once before the first handler
 * and again after each one, whatever the handler returned. The harness
 * had nine, all of them only watching, so every tool round on a 38 MB
 * session held pi's main thread for 118 to 237 ms of ten such builds,
 * and keys typed then waited (12 November, plan item 191; upstream
 * closed the report, earendil-works/pi#10515). One listener made it two
 * builds, still 31 to 52 ms a round on sessions of 36 to 109 MB (15
 * November, plan item 246). So the turn is put together here from what
 * pi says without building anything: the assistant's answer and each
 * tool result as their `message_end`, handed on at the next turn's
 * `turn_start` or the run's `agent_end`, both of which pi awaits before
 * it asks the model again. A handler that must act at the boundary
 * itself, before pi drains the follow-ups it queued, says when it wants
 * to with `onTurnBoundary`, and only then is `turn_end` listened on;
 * the listener lets go once none wants it, with the unsubscribe pi's
 * `on` returns.
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

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	AgentActivityOutcome,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

/** A turn as it ended: its answer, its tool results and how it went. */
export type TurnOver = Pick<
	TurnEndEvent,
	"turnIndex" | "message" | "toolResults" | "outcome"
>;

/** What hears the end of a turn, and changes nothing pi does next. */
export type TurnEndHandler = (
	event: TurnOver,
	ctx: ExtensionContext,
) => void | Promise<void>;

/** Where a later handler offers itself to the session's listener. */
const OFFERS = "agentic-harness.pi/turn-end/offer/v2";

interface Hearer {
	readonly handler: TurnEndHandler;
	/** Present for a handler of the boundary: whether it wants it now. */
	readonly wants?: () => boolean;
}

interface Offer {
	readonly hearer: Hearer;
	taken: boolean;
}

/**
 * Hand `handler` the end of each turn, through the one listener its
 * session's extensions share, without pi building anything for it.
 */
export function onTurnEnd(pi: ExtensionAPI, handler: TurnEndHandler): void {
	join(pi, { handler });
}

/**
 * Hand `handler` each turn at pi's `turn_end` boundary itself, for as
 * long as `wants` says so when the turn's answer or a tool result comes
 * in; pi builds the boundary's context twice a turn only then.
 */
export function onTurnBoundary(
	pi: ExtensionAPI,
	handler: TurnEndHandler,
	wants: () => boolean,
): void {
	join(pi, { handler, wants });
}

function join(pi: ExtensionAPI, hearer: Hearer): void {
	const bus = busOf(pi);
	if (!bus) {
		listen(pi).add(hearer);
		return;
	}
	const offer: Offer = { hearer, taken: false };
	bus.emit(OFFERS, offer);
	if (offer.taken) return;
	const listener = listen(pi);
	listener.add(hearer);
	bus.on(OFFERS, (data) => {
		if (!isOffer(data) || data.taken) return;
		data.taken = true;
		listener.add(data.hearer);
	});
}

interface Turn {
	readonly turnIndex: number;
	readonly message: TurnEndEvent["message"];
	readonly toolResults: ToolResultMessage[];
}

/** One session's listener: the turn so far, and who hears it end. */
function listen(pi: ExtensionAPI): { add(hearer: Hearer): void } {
	const observers: TurnEndHandler[] = [];
	const boundary: Hearer[] = [];
	let turn: Turn | undefined;
	let next = 0;
	let letGo: (() => void) | undefined;
	let listening = false;

	const settle = (): void => {
		const wanted = boundary.some((hearer) => hearer.wants?.() === true);
		if (wanted && !listening) {
			const unsubscribe: unknown = pi.on("turn_end", (event, ctx) =>
				handTurn(
					boundary.map((hearer) => hearer.handler),
					event,
					ctx,
				),
			);
			listening = true;
			letGo =
				typeof unsubscribe === "function" ? () => unsubscribe() : undefined;
		} else if (!wanted && listening && letGo) {
			letGo();
			letGo = undefined;
			listening = false;
		}
	};

	const over = async (ctx: ExtensionContext): Promise<void> => {
		const ended = turn;
		turn = undefined;
		if (!ended) return;
		await handTurn(
			observers,
			{ ...ended, outcome: outcomeOf(ended.message) },
			ctx,
		);
	};

	pi.on("agent_start", () => {
		turn = undefined;
		next = 0;
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role === "assistant") {
			turn = { turnIndex: next++, message, toolResults: [] };
		} else if (message.role === "toolResult") {
			turn?.toolResults.push(message);
		}
		settle();
	});
	pi.on("turn_start", (_event, ctx) => over(ctx));
	pi.on("agent_end", (_event, ctx) => over(ctx));

	return {
		add(hearer) {
			if (hearer.wants) boundary.push(hearer);
			else observers.push(hearer.handler);
		},
	};
}

/** How a turn went, by its answer's stop reason, as pi says it. */
function outcomeOf(message: TurnEndEvent["message"]): AgentActivityOutcome {
	const stopReason = "stopReason" in message ? message.stopReason : undefined;
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return "completed";
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
	if (typeof data !== "object" || data === null) return false;
	if (!("taken" in data) || typeof data.taken !== "boolean") return false;
	if (!("hearer" in data)) return false;
	const hearer: unknown = data.hearer;
	return (
		typeof hearer === "object" &&
		hearer !== null &&
		"handler" in hearer &&
		typeof hearer.handler === "function"
	);
}

/**
 * Each handler in the order it came, as pi would call them: one that
 * fails doesn't keep the turn from the rest, and is said after them.
 */
async function handTurn(
	handlers: readonly TurnEndHandler[],
	event: TurnOver,
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
			`${failures.length} turn handlers failed: ${said.join("; ")}`,
		);
	}
}
