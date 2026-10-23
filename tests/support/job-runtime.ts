/**
 * job-workflow in a runtime of its own, and a reload from one runtime
 * to the next, played the way pi plays them.
 *
 * pi's `reload()` sends `session_shutdown` with reason `reload` to the
 * running extensions, then makes their `pi` and `ctx` stale (every
 * action throws, and their bus subscriptions go), and sends
 * `session_start` with reason `reload` to fresh instances on the same
 * bus. The process, and everything it started, carries on.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jobWorkflow from "../../extensions/job-workflow/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const STALE =
	"This extension ctx is stale after session replacement or reload.";

/** One runtime of job-workflow, what it said, and the way to drive it. */
export interface JobRuntime {
	/** Every prompt it sent, in order. */
	readonly said: string[];
	/** Whether pi would call the session busy. */
	readonly state: { busy: boolean; stale: boolean };
	fire(name: string, event?: unknown): Promise<void>;
	/** What pi does to a runtime once its shutdown has run. */
	invalidate(): void;
}

/** job-workflow loaded into a runtime on `events`, for session `sessionId`. */
export function jobRuntime(events: EventBus, sessionId = "s1"): JobRuntime {
	const handlers = new Map<string, Handler[]>();
	const said: string[] = [];
	const subscriptions: (() => void)[] = [];
	const state = { stale: false, busy: false };
	const live = () => {
		if (state.stale) throw new Error(STALE);
	};
	const pi = {
		events: {
			emit: (channel: string, data: unknown) => {
				live();
				events.emit(channel, data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				live();
				const off = events.on(channel, handler);
				subscriptions.push(off);
				return off;
			},
		},
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: () => {},
		sendUserMessage: (text: string) => {
			live();
			said.push(text);
		},
	};
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => {
			live();
			return !state.busy;
		},
		ui: {
			setStatus: () => live(),
			theme: { fg: (_colour: string, text: string) => text },
			notify: () => {},
			select: async () => undefined,
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI);
	return {
		said,
		state,
		async fire(name, event = {}) {
			for (const handler of handlers.get(name) ?? []) {
				await handler(event, ctx);
			}
		},
		invalidate() {
			state.stale = true;
			for (const off of subscriptions.splice(0)) off();
		},
	};
}

/** Reload `from` into a fresh runtime on the same bus, and answer it. */
export async function reloadJobs(
	events: EventBus,
	from: JobRuntime,
	sessionId = "s1",
): Promise<JobRuntime> {
	await from.fire("session_shutdown", { reason: "reload" });
	from.invalidate();
	const next = jobRuntime(events, sessionId);
	await next.fire("session_start", { reason: "reload" });
	return next;
}

/** Forget whatever a test left parked, so the next test cannot adopt it. */
export function forgetParkedJobs(): void {
	const key = Symbol.for("agentic-harness.jobs.parked.v1");
	const global = globalThis as { [key]?: { timer: NodeJS.Timeout } };
	clearTimeout(global[key]?.timer);
	delete global[key];
}
