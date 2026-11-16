/**
 * A request through pi's stream function, and its stream shown to pi as
 * pi's loop shows one while durable reads the same events at its own
 * pace. An aborted request that will not end is given up on. Durable
 * reaches the stream through the models it is given here.
 */
import type { DurableModels } from "../durable-types.ts";
import type { PiLibrary } from "../pi-library.ts";
import type {
	AgentEvent,
	AgentOptions,
	AssistantMessage,
	Model,
	ProviderEvent,
	ProviderStream,
	StreamFn,
} from "../pi-types.ts";
import { type Renewed, refusedOldKey } from "../renewing-stream.ts";
import type { DurableBinding } from "./binding.ts";
import { EMPTY_USAGE, type Request, type Run } from "./run.ts";

/**
 * How long an aborted request may take to end before the run gives up on
 * it: a provider that honours the abort ends its own stream well within
 * this, and one that waits on its first token is not waited on past it.
 */
const ABANDON_AFTER_MS = 1_000;

/** A hook that may replace a request's payload, as pi's and durable's onPayload do. */
export type PayloadHook = (payload: unknown, model: Model) => unknown;

/** Durable's payload hook, which its options carry untyped. */
export function isPayloadHook(value: unknown): value is PayloadHook {
	return typeof value === "function";
}

/** The agent's options a request is sent with, read as it is sent. */
export interface RequestHooks {
	readonly getApiKey: AgentOptions["getApiKey"];
	readonly streamFunction: StreamFn;
	readonly sessionId: string | undefined;
	readonly onPayload: AgentOptions["onPayload"];
	readonly onResponse: AgentOptions["onResponse"];
	readonly onProviderStreamEvent: AgentOptions["onProviderStreamEvent"];
	readonly transport: string;
	readonly thinkingBudgets: unknown;
	readonly maxRetryDelayMs: number | undefined;
	readonly toolExecution: "parallel" | "sequential";
	readonly identity: unknown;
}

/** What the tee tells the agent: each event for pi, and that the answer came. */
export interface StreamSide {
	emit(event: AgentEvent): Promise<void>;
	/** The answer is in: give back the turn a carried run waited for, once. */
	answered(): void;
}

/** What durable's models read from the agent, each as it is asked. */
export interface ModelsSide {
	/** The run under way, whose model is asked for first. */
	run(): Run | undefined;
	/** The agent's own model. */
	model(): Model;
	stream(options: Record<string, unknown>): ProviderStream;
}

/** The models durable requests through: pi's stream, with pi's options, for each request. */
export function durableModels(side: ModelsSide): DurableModels {
	return new Proxy(
		{
			getModel: (provider: string, id: string): Model | undefined => {
				const run = side.run();
				for (const model of [run?.model, side.model()]) {
					if (model && model.provider === provider && model.id === id)
						return model;
				}
				return undefined;
			},
			streamSimple: (
				_model: Model,
				_context: unknown,
				options?: Record<string, unknown>,
			) => side.stream(options ?? {}),
		},
		{
			get(target, name, receiver) {
				if (name in target) return Reflect.get(target, name, receiver);
				if (typeof name === "symbol" || name === "then") return undefined;
				// Present, since durable binds what it wraps; refused when called, so a new use shows at once.
				return () => {
					throw new Error(
						`The host's agent offers durable no Models.${name}; pi owns that`,
					);
				};
			},
		},
	);
}

/** Send one request through pi's stream function, with the conversation's credentials. */
export async function openRequest(
	hooks: RequestHooks,
	library: PiLibrary,
	durable: DurableBinding,
	request: Request,
	signal: AbortSignal,
	durablePayload: PayloadHook | undefined,
): Promise<ProviderStream> {
	const apiKey = hooks.getApiKey
		? await hooks.getApiKey(request.model.provider)
		: undefined;
	const env = await durable.env();
	return hooks.streamFunction(
		request.model,
		{ messages: request.messages },
		{
			model: request.model,
			reasoning: request.reasoning,
			sessionId: hooks.sessionId,
			onPayload: async (payload: unknown, model: Model) => {
				const ours = hooks.onPayload
					? await hooks.onPayload(payload, model)
					: undefined;
				const next = ours === undefined ? payload : ours;
				return durablePayload ? durablePayload(next, model) : next;
			},
			onResponse: hooks.onResponse,
			onProviderStreamEvent: hooks.onProviderStreamEvent,
			transport: hooks.transport,
			thinkingBudgets: hooks.thinkingBudgets,
			maxRetryDelayMs: hooks.maxRetryDelayMs,
			toolExecution: hooks.toolExecution,
			...(apiKey ? { apiKey } : {}),
			identity: library.mergeClientIdentity(
				library.defaultAgentIdentity,
				hooks.identity,
			),
			signal,
			env: { ...env },
		},
	);
}

/**
 * Show pi the stream's events as its loop does, and hand durable the same
 * stream. Once `signal` aborts, the stream ends within ABANDON_AFTER_MS on
 * an aborted answer, whether or not the provider has ended its own: a
 * park, a close and a person's Esc all wait on that, and a provider may
 * not look at the signal until its first token.
 */
export function teeStream(
	run: Run,
	request: Request,
	signal: AbortSignal,
	open: () => Promise<ProviderStream>,
	renewed: Renewed | undefined,
	side: StreamSide,
): ProviderStream {
	const answer = run.answer ?? { started: false };
	run.answer = answer;
	let final: Promise<AssistantMessage> | undefined;
	/** The aborted answer the run gave up on the provider with, once it has. */
	let abandoned: AssistantMessage | undefined;
	const finish = async (stream: ProviderStream): Promise<AssistantMessage> => {
		final ??= (async () => {
			const message = await stream.result();
			// An answer that comes after the run gave up on it changes nothing.
			if (abandoned) return abandoned;
			message.thinkingLevel = request.reasoning ?? "off";
			const messages = run.context.messages;
			if (answer.started) messages[messages.length - 1] = message;
			else messages.push(message);
			answer.message = message;
			side.answered();
			return message;
		})();
		return final;
	};
	// pi's loop reads the provider's own stream as it arrives and tells
	// extensions each event then; durable reads at its own pace, so the
	// stream is read here, unwrapped, and durable is handed what was read.
	const read: ProviderEvent[] = [];
	let ended = false;
	let failure: { readonly error: unknown } | undefined;
	let wake = () => {};
	let leave: (message: AssistantMessage) => void = () => {};
	const left = new Promise<AssistantMessage>((done) => {
		leave = done;
	});
	const abandon = (): void => {
		if (answer.message || abandoned) return;
		const message = abortedAnswer(request, answer.partial);
		abandoned = message;
		final = Promise.resolve(message);
		const messages = run.context.messages;
		if (answer.started) messages[messages.length - 1] = message;
		else messages.push(message);
		answer.message = message;
		ended = true;
		wake();
		leave(message);
	};
	let grace: ReturnType<typeof setTimeout> | undefined;
	const aborted = (): void => {
		grace = setTimeout(abandon, ABANDON_AFTER_MS);
	};
	if (signal.aborted) aborted();
	else signal.addEventListener("abort", aborted, { once: true });
	const settled = (): void => {
		clearTimeout(grace);
		signal.removeEventListener("abort", aborted);
	};
	let opened = open();
	const reading = (async () => {
		let stream = await opened;
		// Only the first event of the first stream can be a refused key.
		let renewable = renewed;
		for (;;) {
			let reopen = false;
			for await (const event of stream) {
				const asked = renewable;
				renewable = undefined;
				// Only an error is awaited, so a start reaches pi when its loop's would.
				if (
					asked &&
					event.type === "error" &&
					(await refusedOldKey(event, asked))
				) {
					reopen = true;
					break;
				}
				// Given up on, what the provider sends at last is neither shown nor read.
				if (abandoned) break;
				if (event.type === "start" && event.partial) {
					answer.partial = event.partial;
					run.context.messages.push(event.partial);
					answer.started = true;
					await side.emit({
						type: "message_start",
						message: { ...event.partial },
					});
				} else if (event.type === "done" || event.type === "error") {
					await finish(stream);
				} else if (answer.started && event.partial) {
					answer.partial = event.partial;
					run.context.messages[run.context.messages.length - 1] = event.partial;
					await side.emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...event.partial },
					});
				}
				read.push(event);
				wake();
			}
			if (!reopen || abandoned) break;
			opened = open();
			stream = await opened;
		}
		await finish(stream);
	})().then(
		() => {
			settled();
			ended = true;
			wake();
		},
		(error: unknown) => {
			settled();
			// Held for durable, which meets it when it reads this far; an abandoned stream already ended.
			if (!abandoned) failure = { error };
			wake();
		},
	);
	const events = async function* (): AsyncGenerator<ProviderEvent> {
		for (;;) {
			const event = read.shift();
			if (event) {
				yield event;
				continue;
			}
			if (failure) throw failure.error;
			if (ended) return;
			await new Promise<void>((done) => {
				wake = done;
			});
		}
	};
	const iterable = events();
	return {
		[Symbol.asyncIterator]: () => iterable,
		result: async () => {
			const answered = (async () => {
				await reading;
				return finish(await opened);
			})();
			answered.catch(() => {
				// The race below meets this failure unless the run gave up on it first.
			});
			return { ...(await Promise.race([answered, left])) };
		},
	};
}

/** The answer a request given up on after its abort ends with, as pi-ai's providers end an aborted stream. */
function abortedAnswer(
	request: Request,
	partial: AssistantMessage | undefined,
): AssistantMessage {
	return {
		usage: EMPTY_USAGE,
		...(partial ?? {}),
		role: "assistant",
		content: partial?.content ?? [],
		api: partial?.api ?? request.model.api,
		provider: partial?.provider ?? request.model.provider,
		model: partial?.model ?? request.model.id,
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
		thinkingLevel: request.reasoning ?? "off",
	};
}
