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
const BAD_REQUEST = "400 invalid_request_error: the request is malformed";
const ESCAPE = "\u001b";
/** Escape as the Kitty keyboard protocol sends it, pressed and let go. */
const KITTY_ESCAPE = "\u001b[27u";
const KITTY_ESCAPE_RELEASE = "\u001b[27;1:3u";
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
	/**
	 * Tries finished but not yet said, as job-workflow's outbox holds a
	 * result while it can't send it; only when `holding` is set.
	 */
	outbox: { summary: string; said: () => void }[];
	holding: boolean;
	/** Whether a run is under way, as pi's `isIdle` answers. */
	busy: boolean;
}

function session(): Session {
	return {
		branch: [],
		tries: [],
		notices: [],
		status: new Map(),
		outbox: [],
		holding: false,
		busy: false,
	};
}

/** A try said to the model, as job-workflow says a result. */
function say(held: Session, summary: string): void {
	held.tries.push(summary);
	held.branch.push({
		type: "message",
		message: { role: "user", content: summary },
	});
}

/** Every try the outbox held, said now. */
function deliver(held: Session): void {
	for (const waiting of held.outbox.splice(0)) {
		say(held, waiting.summary);
		waiting.said();
	}
}

/** How a load of the workflow differs from the usual one. */
interface LoadOptions {
	/** A window with no raw key input, as some hosts give. */
	keyless?: boolean;
}

/** One load of the workflow into `held`, as pi loads it at a start or reload. */
function loaded(held: Session, options: LoadOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const keys: ((data: string) => unknown)[] = [];
	const host: JobHost = {
		start: (spec) => {
			let delivered: (() => void) | undefined;
			let pending: Session["outbox"][number] | undefined;
			const job: Job = {
				id: `j${held.tries.length + held.outbox.length + 1}`,
				signal: new AbortController().signal,
				finish: ({ summary }) => {
					if (held.holding) {
						pending = { summary, said: () => delivered?.() };
						held.outbox.push(pending);
						return;
					}
					say(held, summary);
					delivered?.();
				},
				onDelivered: (listener) => {
					delivered = listener;
				},
				withdraw: () => {
					const at = pending ? held.outbox.indexOf(pending) : -1;
					if (at < 0) return false;
					held.outbox.splice(at, 1);
					return true;
				},
			};
			expect(spec.kind).toBe("model-retry");
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
	const onTerminalInput = (listener: (data: string) => unknown) => {
		keys.push(listener);
		return () => keys.splice(keys.indexOf(listener), 1);
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !held.busy,
		model: { contextWindow: 200_000 },
		sessionManager: { getBranch: () => held.branch },
		ui: {
			theme: { fg: (_colour: string, text: string) => text },
			notify: (text: string, kind: string) => held.notices.push({ text, kind }),
			setStatus: (key: string, text: string | undefined) =>
				held.status.set(key, text),
			...(options.keyless ? {} : { onTerminalInput }),
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
		/** A run stopped with Escape after it ended on `last`. */
		async stopped(last: AssistantMessage) {
			await fire("agent_start");
			held.branch.push({ type: "message", message: last });
			await fire("agent_end", { messages: [last] });
			await fire("agent_settled", { aborted: true });
		},
		typed: (text = "carry on") =>
			fire("input", { text, source: "interactive" }),
		pressed: (data: string) => {
			for (const listener of [...keys]) listener(data);
		},
		prompt: (open: boolean) =>
			fire(open ? "ui_prompt_start" : "ui_prompt_end", { reason: "ui_prompt" }),
		/** A reload, which parks job-workflow's outbox for the next load. */
		shutdown: () => fire("session_shutdown", { reason: "reload" }),
		/**
		 * A host restart: job-workflow, loaded first, keeps what it had not
		 * said in a `job-carried` record for the next start to say.
		 */
		async restarted() {
			if (held.outbox.length > 0) {
				held.branch.push({
					type: "custom",
					customType: "job-carried",
					data: {
						at: Date.now(),
						jobs: [],
						results: held.outbox.map((waiting, at) => ({
							jobId: `j${at + 1}`,
							label: "try the failed model call again",
							text: waiting.summary,
						})),
					},
				});
			}
			const kept = held.outbox.map((waiting) => waiting.summary);
			await fire("session_shutdown", { reason: "quit" });
			// The process goes, and with it the outbox; the record keeps them.
			held.outbox.splice(0);
			return kept;
		},
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
		for (let attempt = 1; attempt <= 6; attempt++) {
			await pi.ran(reply("error", RELAY_502));
			await passes(LONGEST_WAIT_MS);
		}
		await pi.ran(reply("error", RELAY_502));
		expect(
			held.notices.at(-1)?.text,
			"the seventh waits the longest wait",
		).toMatch(/Trying again in 300 s \(try 7\)/);
		await passes(LONGEST_WAIT_MS - 1);
		expect(held.tries, "not before the longest wait").toHaveLength(6);
		await passes(1);
		await pi.ran(reply("error", RELAY_502));
		await passes(LONGEST_WAIT_MS);
		expect(
			held.tries,
			"every failure past pi's own retries is tried again",
		).toHaveLength(8);
		expect(held.tries[7], "the eighth try says it is the eighth").toContain(
			"try 8",
		);
	});

	it("leaves the wait to a run that starts during it", async () => {
		// A mesh message or a steer starts a run of its own, whose settling
		// decides what comes next.
		const held = session();
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS / 2);
		await pi.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS / 2);
		expect(held.tries, "the first wait went with that run").toHaveLength(0);
		await passes(2 * FIRST_WAIT_MS);
		expect(held.tries).toHaveLength(1);
		expect(held.tries[0], "the count goes on through it").toContain("try 2");
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
		await pi.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		const shown = held.notices.length;
		pi.pressed(ESCAPE);
		expect(
			held.notices,
			"an Escape once the try is said says nothing",
		).toHaveLength(shown);
		await pi.ran(reply("error", RELAY_502));
		await passes(2 * FIRST_WAIT_MS);
		expect(held.tries[1], "nor stops the count").toContain("try 2");
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

	it("is heard as the Kitty keyboard protocol sends it", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		pi.pressed(KITTY_ESCAPE);
		await passes(LONGEST_WAIT_MS);
		expect(held.tries).toHaveLength(0);
	});

	it("does not hear a key let go", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		pi.pressed(KITTY_ESCAPE_RELEASE);
		await passes(FIRST_WAIT_MS);
		expect(held.tries).toHaveLength(1);
	});

	it("leaves an Escape that closes a dialog or panel to it", async () => {
		const held = session();
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		await pi.prompt(true);
		pi.pressed(ESCAPE);
		await pi.prompt(false);
		await passes(FIRST_WAIT_MS);
		expect(held.tries, "the wait goes on").toHaveLength(1);
	});

	it("is not offered where the window can't hear it", async () => {
		const held = session();
		const pi = loaded(held, { keyless: true });
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		const notice = held.notices.at(-1)?.text;
		expect(notice).toMatch(/Type to stop\.$/);
		expect(notice).not.toMatch(/Escape/);
	});
});

describe("Escape on a run", () => {
	it("stops the count for the loads that follow too", async () => {
		// Escape during pi's own retry leaves its failed reply last.
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.stopped(reply("error", RELAY_502));
		await before.shutdown();
		const after = loaded(held);
		await after.started("reload");
		await passes(LONGEST_WAIT_MS);
		expect(held.tries).toHaveLength(0);
	});
});

describe("a try held unsaid as the load ends", () => {
	it("is said once after a reload, by the load that follows", async () => {
		const held = session();
		held.holding = true;
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		expect(held.outbox, "the try waits to be said").toHaveLength(1);
		await before.shutdown();
		expect(held.outbox, "the closing load takes it back").toHaveLength(0);
		held.holding = false;
		const after = loaded(held);
		await after.started("reload");
		await passes(FIRST_WAIT_MS);
		expect(held.tries).toHaveLength(1);
		expect(held.tries[0]).toContain("try 1");
	});

	it("is said once after a restart, by job-workflow's record", async () => {
		const held = session();
		held.holding = true;
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		const kept = await before.restarted();
		held.holding = false;
		const shown = held.notices.length;
		const after = loaded(held);
		await after.started("startup");
		expect(
			held.notices,
			"no second wait is set beside the kept try",
		).toHaveLength(shown);
		for (const summary of kept) say(held, summary);
		await passes(LONGEST_WAIT_MS);
		expect(held.tries).toHaveLength(1);
		await after.ran(reply("error", RELAY_502));
		await passes(2 * FIRST_WAIT_MS);
		expect(held.tries[1], "the count goes on from the kept try").toContain(
			"try 2",
		);
	});

	it("is not said once the person stops the wait", async () => {
		const held = session();
		held.holding = true;
		const pi = loaded(held);
		await pi.started();
		await pi.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		await pi.typed();
		deliver(held);
		expect(held.tries, "typing takes the try back").toHaveLength(0);
	});
});

describe("a load that starts with a run under way", () => {
	it("leaves the wait to that run's settling", async () => {
		const held = session();
		held.branch.push({ type: "message", message: reply("error", RELAY_502) });
		held.busy = true;
		const after = loaded(held);
		await after.started("reload");
		await passes(LONGEST_WAIT_MS);
		expect(held.tries).toHaveLength(0);
	});
});

describe("a streak a reload reads back", () => {
	it("ends at a failure no try gets past, as the live count does", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await passes(FIRST_WAIT_MS);
		await before.ran(reply("error", BAD_REQUEST));
		held.branch.push({ type: "message", message: reply("error", RELAY_502) });
		await before.shutdown();
		const after = loaded(held);
		await after.started("reload");
		await passes(FIRST_WAIT_MS);
		expect(held.tries).toHaveLength(2);
		expect(held.tries[1], "a new streak starts at its first try").toContain(
			"try 1",
		);
	});

	it("waits at least the first wait for a try left overdue", async () => {
		const held = session();
		const before = loaded(held);
		await before.started();
		await before.ran(reply("error", RELAY_502));
		await before.shutdown();
		await passes(10 * FIRST_WAIT_MS);
		const after = loaded(held);
		await after.started("reload");
		await passes(FIRST_WAIT_MS - 1);
		expect(held.tries, "the person sees the notice first").toHaveLength(0);
		await passes(1);
		expect(held.tries).toHaveLength(1);
	});
});
