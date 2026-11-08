/**
 * A stand-in for pi's extension API, for tests that hand one to the
 * code under test.
 *
 * Dozens of test files each used to write their own. The copies had
 * drifted: some kept what was appended to the session and some dropped
 * it, some had a bus and some did not, and two carried a comment saying
 * the pi package could not be imported from a test, long after it
 * could. A change to pi's API meant finding every copy. With one home
 * it is one fix, and one fake for a reader to learn.
 *
 * It answers the members extensions reach for most and records what
 * was done with each, so a test asserts on what happened rather than
 * wiring up arrays of its own. Every other member is missing on
 * purpose: calling one throws, which says the fake does not cover it
 * instead of quietly doing nothing. Pass such a member, or a different
 * answer for one it has, through `overrides`.
 *
 * The result is the API itself, with what was recorded hung on it, so
 * a test that only needs something to pass along can write `fakePi()`
 * where the API goes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
type UserMessage = Parameters<ExtensionAPI["sendUserMessage"]>[0];

/**
 * A handler as `on` received it. Each of pi's events takes its own
 * event type, so a record of all of them can only say this much.
 */
type Handler = (event: unknown, ctx: unknown) => unknown;

/** A listener on pi's bus. */
type Listener = (data: unknown) => void;

/** One entry appended to the session, as the code under test gave it. */
export interface AppendedEntry {
	customType: string;
	data: unknown;
}

/** What the code under test did with a fake pi, in the order it did it. */
export interface Recorded {
	/** Each tool registered. */
	tools: Tool[];
	/** Each command registered, by its name. */
	commands: Map<string, CommandOptions>;
	/** The handlers given to `on` and not yet disposed of, by event. */
	handlers: Map<string, Handler[]>;
	/** Each message sent with `sendMessage`. */
	sent: Message[];
	/** Each message sent as the user with `sendUserMessage`. */
	sentAsUser: UserMessage[];
	/** Each entry appended to the session. */
	entries: AppendedEntry[];
	/** Each thing said on the bus, as its channel and its data. */
	emitted: [channel: string, data: unknown][];
	/** Each name the session was given. */
	sessionNames: string[];
}

/** A fake pi: the API to hand over, carrying what was done with it. */
export type FakePi = ExtensionAPI & { recorded: Recorded };

/**
 * A fresh fake pi, recording from empty.
 *
 * Its bus delivers what is said on it to every listener at once, in
 * the order they listened, as pi's does. An override replaces the
 * member outright, so what an overridden member is given is not
 * recorded.
 */
export function fakePi(overrides: Partial<ExtensionAPI> = {}): FakePi {
	const recorded: Recorded = {
		tools: [],
		commands: new Map(),
		handlers: new Map(),
		sent: [],
		sentAsUser: [],
		entries: [],
		emitted: [],
		sessionNames: [],
	};
	const listeners = new Map<string, Listener[]>();
	const fake = {
		registerTool: (tool: Tool) => {
			recorded.tools.push(tool);
		},
		registerCommand: (name: string, options: CommandOptions) => {
			recorded.commands.set(name, options);
		},
		on: (event: string, handler: Handler) => {
			recorded.handlers.set(event, [
				...(recorded.handlers.get(event) ?? []),
				handler,
			]);
			return () => {
				recorded.handlers.set(
					event,
					(recorded.handlers.get(event) ?? []).filter((h) => h !== handler),
				);
			};
		},
		sendMessage: (message: Message) => {
			recorded.sent.push(message);
		},
		sendUserMessage: (message: UserMessage) => {
			recorded.sentAsUser.push(message);
		},
		appendEntry: (customType: string, data?: unknown) => {
			recorded.entries.push({ customType, data });
		},
		setSessionName: (name: string) => {
			recorded.sessionNames.push(name);
		},
		events: {
			emit: (channel: string, data: unknown) => {
				recorded.emitted.push([channel, data]);
				for (const listener of listeners.get(channel) ?? []) listener(data);
			},
			on: (channel: string, listener: Listener) => {
				listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
				return () => {
					listeners.set(
						channel,
						(listeners.get(channel) ?? []).filter((l) => l !== listener),
					);
				};
			},
		},
	};
	return { ...fake, ...overrides, recorded } as unknown as FakePi;
}
