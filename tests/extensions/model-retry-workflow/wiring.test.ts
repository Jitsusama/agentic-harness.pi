/**
 * The model-retry workflow driven through the events pi emits, with a
 * job host standing in for job-workflow's and the session's branch
 * kept as a list, so a reload or a restart can hand the same record to
 * a fresh load.
 */

import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelRetryWorkflow from "../../../extensions/model-retry-workflow/index.ts";
import {
	FIRST_WAIT_MS,
	LONGEST_WAIT_MS,
} from "../../../lib/internal/errors/model-failure.ts";
import { JOBS_ASK, type Job, type JobHost } from "../../../lib/jobs/host.ts";
import { fakePi } from "../../support/fake-pi.ts";

const RELAY_502 = "502 this relay's request to its origin failed";
const ESCAPE = "\u001b";
const HOUR_MS = 3_600_000;

type Handler = (event: unknown, ctx: unknown) => unknown;

/** One entry of the session's branch, as far as this workflow reads it. */
type Entry =
	| {
			type: "message";
			message: AssistantMessage | { role: "user"; content: string };
	  }
	| { type: "custom"; customType: string; data: unknown };

function reply(
	stopReason: StopReason,
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

/** What the session shows and holds, shared by every load of it. */
interface Session {
	branch: Entry[];
	/** Each try said through the job host, as the model would read it. */
	tries: string[];
	notices: { text: string; kind: string }[];
	status: Map<string, string | undefined>;
}

function session(): Session {
	return { branch: [], tries: [], notices: [], status: new Map() };
}

/** One load of the workflow into `held`, as pi loads it at a start or reload. */
function loaded(held: Session) {
	const handlers = new Map<string, Handler[]>();
	const keys: ((data: string) => unknown)[] = [];
	const host: JobHost = {
		start: () => {
			let delivered: (() => void) | undefined;
			const job: Job = {
				id: `j${held.tries.length + 1}`,
				signal: new AbortController().signal,
				finish: ({ summary }) => {
					held.tries.push(summary);
					held.branch.push({
						type: "message",
						message: { role: "user", content: summary },
					});
					delivered?.();
				},
				onDelivered: (listener) => {
					delivered = listener;
				},
				withdraw: () => false,
			};
			return job;
		},
	};
	const pi = fakePi({
		on: ((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}) as never,
		appendEntry: ((customType: string, data: unknown) => {
			held.branch.push({ type: "custom", customType, data });
		}) as never,
	});
	pi.events.on(JOBS_ASK, (answer) => {
		if (typeof answer === "function") answer(host);
	});
	modelRetryWorkflow(pi);
	const ctx = {
		hasUI: true,
		model: { contextWindow: 200_000 },
		sessionManager: { getBranch: () => held.branch },
		ui: {
			theme: { fg: (_colour: string, text: string) => text },
			notify: (text: string, kind: string) => held.notices.push({ text, kind }),
			setStatus: (key: string, text: string | undefined) =>
				held.status.set(key, text),
			onTerminalInput: (listener: (data: string) => unknown) => {
				keys.push(listener);
				return () => keys.splice(keys.indexOf(listener), 1);
			},
		},
	};
	const fire = async (event: string, payload: object = {}) => {
		for (const handler of handlers.get(event) ?? [])
			await handler({ type: event, ...payload }, ctx);
	};
	return {
		started: (reason = "startup") => fire("session_start", { reason }),
		/** A run that ended on `last`, settling with nothing left of pi's. */
		async ran(last: AssistantMessage) {
			await fire("agent_start");
			held.branch.push({ type: "message", message: last });
			await fire("agent_end", { messages: [last] });
			await fire("agent_settled", { aborted: false });
		},
		typed: (text = "carry on") =>
			fire("input", { text, source: "interactive" }),
		pressed: (data: string) => {
			for (const listener of [...keys]) listener(data);
		},
		shutdown: () => fire("session_shutdown", { reason: "reload" }),
	};
}

/** Time passing, with every timer due in it run. */
const passes = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a turn that keeps failing for a moment", () => {
	it("keeps trying past six tries, at the longest wait", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		for (let attempt = 1; attempt <= 8; attempt++) {
			await pi.ran(reply("error", RELAY_502));
			await passes(LONGEST_WAIT_MS);
		}
		expect(
			held.tries,
			"every failure past pi's own retries is tried again",
		).toHaveLength(8);
		expect(held.tries[7], "the eighth try says it is the eighth").toContain(
			"try 8",
		);
		expect(
			held.notices.some((notice) => /still fails/.test(notice.text)),
			"no try is the last while the call fails for a moment",
		).toBe(false);
	});
});

describe("a wait a reload cuts short", () => {
	it("is taken up by the load that follows", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await before.shutdown();
		const after = loaded(held);
		await after.started("reload");
		await passes(FIRST_WAIT_MS);
		expect(
			held.tries,
			"the reloaded session tries the call it was waiting on",
		).toHaveLength(1);
		expect(held.tries[0]).toContain("try 1");
		expect(
			held.status.get("model-retry"),
			"the footer mark goes once the try is said",
		).toBeUndefined();
	});

	it("is taken up when the reload came before the wait was kept", async () => {
		// reload-workflow reloads at agent_settled too, and on 18 November
		// did so seconds after the last 502, with no try ever scheduled.
		const held = session();
		held.branch.push({ type: "message", message: reply("error", RELAY_502) });
		const after = loaded(held);
		await after.started("reload");
		await passes(FIRST_WAIT_MS - 1);
		expect(held.tries, "never sooner than the first wait").toHaveLength(0);
		await passes(1);
		expect(held.tries).toHaveLength(1);
		expect(
			held.notices.at(-1)?.text,
			"the window says it is trying again",
		).toMatch(/Trying again in 30 s/);
	});
});

describe("a wait a restart cuts short", () => {
	it("carries on the count from the tries before it", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		await before.ran(reply("error", RELAY_502));
		// The host restarts here, with the second try pending; its timer
		// goes with its process.
		await before.shutdown();
		const after = loaded(held);
		await after.started("startup");
		await passes(2 * FIRST_WAIT_MS);
		expect(
			held.tries,
			"the restarted session makes the second try",
		).toHaveLength(2);
		expect(held.tries[1]).toContain("try 2");
	});

	it("leaves a failure an hour old alone", async () => {
		const held = session();
		held.branch.push({ type: "message", message: reply("error", RELAY_502) });
		await passes(HOUR_MS + 1);
		const after = loaded(held);
		await after.started("startup");
		await passes(LONGEST_WAIT_MS);
		expect(
			held.tries,
			"an old session opened again does not set off on its own",
		).toHaveLength(0);
	});

	it("counts afresh after a reply that did not fail", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		await before.ran(reply("stop"));
		held.branch.push({ type: "message", message: reply("error", RELAY_502) });
		const after = loaded(held);
		await after.started("startup");
		await passes(FIRST_WAIT_MS);
		expect(held.tries).toHaveLength(2);
		expect(held.tries[1], "a new streak starts at its first try").toContain(
			"try 1",
		);
	});

	it("does not take up a wait the person typed over", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await before.typed();
		const after = loaded(held);
		await after.started("reload");
		await passes(LONGEST_WAIT_MS);
		expect(held.tries, "a typed line is the person's to judge").toHaveLength(0);
	});
});

describe("Escape while it waits", () => {
	it("stops the wait and says so", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		pi.pressed(ESCAPE);
		await passes(LONGEST_WAIT_MS);
		expect(held.tries, "Escape stops the try").toHaveLength(0);
		expect(
			held.status.get("model-retry"),
			"the footer mark goes",
		).toBeUndefined();
		expect(held.notices.at(-1)?.text).toMatch(/Stopped trying/);
	});

	it("is not taken up again by a reload", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		before.pressed(ESCAPE);
		await before.shutdown();
		const after = loaded(held);
		await after.started("reload");
		await passes(LONGEST_WAIT_MS);
		expect(held.tries).toHaveLength(0);
	});

	it("is only heard while a wait runs", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		pi.pressed(ESCAPE);
		expect(
			held.notices,
			"an Escape with nothing waiting says nothing",
		).toHaveLength(0);
	});

	it("leaves other keys alone", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		pi.pressed("x");
		await passes(FIRST_WAIT_MS);
		expect(held.tries).toHaveLength(1);
	});
});
