/**
 * A run the compaction interrupted resumes as a prompt, wired up.
 *
 * pi starts a run from `sendMessage(..., { triggerTurn: true })`
 * without emitting `before_agent_start`, so that run is built on the
 * base system prompt: none of what extensions append there (the
 * resident conventions, the loaded quest) reaches it. Measured on pi
 * 0.87.1, the resumed request's system prompt was 4,813 characters
 * shorter, missing every captured rule, and the next typed message put
 * them back, which rewrote the whole context after the tool
 * definitions at the cache-write price. `sendUserMessage` goes through
 * pi's prompt path, which emits the hook, so the resumed run carries
 * the same system prompt a typed message would.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import compactionWorkflow from "../../../extensions/compaction-workflow/index.ts";
import {
	ASKED_ENTRY,
	FAILED_RESUME_TEXT,
	FAILED_WAITING_TEXT,
	RESUME_TEXT,
	SETTLED_ENTRY,
	WAITING_TEXT,
} from "../../../lib/compaction/resume.ts";
import { endTurn } from "../../support/turn-end.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Recorded {
	sendMessage: unknown[][];
	sendUserMessage: unknown[][];
	appendEntry: unknown[][];
	/** Each entry type appended and each send, in the order they came. */
	order: string[];
}

/** What pi throws from a pi or ctx a reload or a session switch replaced. */
const STALE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

/** Just enough of pi for the extension to register and be driven. */
function activate(
	stale = { now: false },
	broken: { append?: Error } = {},
): {
	handlers: Map<string, Handler>;
	calls: Recorded;
} {
	const handlers = new Map<string, Handler>();
	const calls: Recorded = {
		sendMessage: [],
		sendUserMessage: [],
		appendEntry: [],
		order: [],
	};
	const live =
		<T extends unknown[]>(act: (...args: T) => unknown) =>
		(...args: T) => {
			if (stale.now) throw new Error(STALE);
			act(...args);
		};
	const pi = {
		events: {
			on: () => () => {},
			emit: live(() => {}),
		},
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: live((...args: unknown[]) => {
			if (broken.append) throw broken.append;
			calls.appendEntry.push(args);
			calls.order.push(String(args[0]));
		}),
		registerCommand: () => {},
		sendMessage: live((...args: unknown[]) => calls.sendMessage.push(args)),
		sendUserMessage: live((...args: unknown[]) => {
			calls.sendUserMessage.push(args);
			calls.order.push("send");
		}),
	};
	compactionWorkflow(pi as unknown as ExtensionAPI);
	return { handlers, calls };
}

/** A session context whose compaction ends the way `outcome` says. */
function context(
	tokens: () => number,
	outcome: (options: {
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}) => void,
	branch: () => unknown[] = () => [],
) {
	return {
		mode: "rpc",
		hasUI: false,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: tokens() }),
		model: {
			api: "anthropic-messages",
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		},
		hasPendingMessages: () => false,
		compact: outcome,
		sessionManager: {
			getBranch: branch,
			getLeafId: () => null,
			getSessionId: () => "s1",
		},
	};
}

/**
 * Drive turns until the policy compacts: turns that made tool calls,
 * unless `toolResults` says they made none. `overrides` replaces parts
 * of the session context, such as what is waiting to go.
 */
async function runUntilCompaction(
	outcome: (
		options: Parameters<Parameters<typeof context>[1]>[0],
		handlers: Map<string, Handler>,
	) => void,
	branch?: () => unknown[],
	toolResults: unknown[] = [{}],
	overrides: object = {},
): Promise<Recorded> {
	const { handlers, calls } = activate();
	let size = 60_000;
	let compacted = false;
	const ctx = {
		...context(
			() => size,
			(options) => {
				compacted = true;
				outcome(options, handlers);
			},
			branch,
		),
		...overrides,
	};
	await handlers.get("session_start")?.({}, ctx);
	const turnEnd = (turn: object) =>
		endTurn((name, event, at) => handlers.get(name)?.(event, at), turn, ctx);
	await turnEnd({ toolResults });
	size = 900_000;
	for (let turn = 0; turn < 200 && !compacted; turn++) {
		await turnEnd({ toolResults });
	}
	if (!compacted) throw new Error("the policy never compacted");
	// A resume is started once pi is idle, a turn on.
	await nextTurn();
	return calls;
}

/** An answer the compaction's abort cut, as pi logs it. */
function aborted(ms: number) {
	return {
		type: "message",
		timestamp: new Date(ms).toISOString(),
		message: { role: "assistant", stopReason: "aborted", content: [] },
	};
}

/** The ask a runtime wrote, as the log holds it. */
function askEntry(ms: number, data: unknown) {
	return {
		type: "custom",
		customType: ASKED_ENTRY,
		timestamp: new Date(ms).toISOString(),
		data,
	};
}

function compactionEntry(ms: number) {
	return { type: "compaction", timestamp: new Date(ms).toISOString() };
}

/** An answer that ended on its own, as pi logs it. */
function finished(ms: number) {
	return {
		type: "message",
		timestamp: new Date(ms).toISOString(),
		message: { role: "assistant", stopReason: "stop", content: [] },
	};
}

/** An ask's settling, as the log holds it. */
function settledEntry(ms: number) {
	return {
		type: "custom",
		customType: SETTLED_ENTRY,
		timestamp: new Date(ms).toISOString(),
		data: { at: ms, resumed: false, by: "asker" },
	};
}

/** One turn of the loop, after which a deferred check has run. */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Long enough for a check waiting on pi's idle to look again. */
const nextLook = () =>
	// A check that found pi busy looks again a quarter-second on.
	new Promise((resolve) => setTimeout(resolve, 400));

/** Long enough for a run for waiting messages to take its first look. */
const settles = () =>
	// It holds its first look half a second, for a prompt still starting.
	new Promise((resolve) => setTimeout(resolve, 600));

/** A prompt pi's screen sent, as an input handler hears it. */
const input = (handlers: Map<string, Handler>, streamingBehavior?: string) =>
	handlers.get("input")?.(
		{
			type: "input",
			text: "and this",
			source: "interactive",
			streamingBehavior,
		},
		{},
	);

/** The entries of a type a runtime appended. */
const appended = (calls: Recorded, type: string) =>
	calls.appendEntry.filter(([written]) => written === type).map(([, d]) => d);

describe("resuming the run a compaction interrupted", () => {
	it("resumes after a compaction through the prompt path", async () => {
		const calls = await runUntilCompaction((options) => options.onComplete?.());

		expect(calls.sendMessage).toEqual([]);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(RESUME_TEXT);
	});

	it("tries again after a compaction that could not start", async () => {
		const { handlers } = activate();
		let attempts = 0;
		let size = 60_000;
		const ctx = context(
			() => size,
			() => {
				attempts += 1;
				if (attempts === 1) throw new Error("This extension ctx is stale.");
			},
		);
		await handlers.get("session_start")?.({}, ctx);
		const turnEnd = (turn: object) =>
			endTurn((name, event, at) => handlers.get(name)?.(event, at), turn, ctx);
		await turnEnd({ toolResults: [{}] });
		size = 900_000;

		for (let turn = 0; turn < 200 && attempts < 2; turn++) {
			try {
				await turnEnd({ toolResults: [{}] });
			} catch {
				// pi catches a handler's throw; so does this stand-in.
			}
		}

		expect(attempts).toBe(2);
	});

	it("settles an ask whose compaction couldn't start", async () => {
		const { handlers, calls } = activate();
		let size = 60_000;
		let thrown = false;
		const ctx = context(
			() => size,
			() => {
				thrown = true;
				throw new Error("compaction refused");
			},
		);
		await handlers.get("session_start")?.({}, ctx);
		const turnEnd = (turn: object) =>
			endTurn((name, event, at) => handlers.get(name)?.(event, at), turn, ctx);
		await turnEnd({ toolResults: [{}] });
		size = 900_000;
		for (let turn = 0; turn < 200 && !thrown; turn++) {
			try {
				await turnEnd({ toolResults: [{}] });
			} catch {
				// pi catches a handler's throw; so does this stand-in.
			}
		}

		expect(calls.order).toEqual([ASKED_ENTRY, SETTLED_ENTRY]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "asker" }),
		]);
	});

	it("ends quietly when a reload replaced it before the compaction ended", async () => {
		// On 22 October a compaction failed after a reload, its onError
		// wrote through the old pi, and the throw took pi down.
		const stale = { now: false };
		const { handlers } = activate(stale);
		const ended: Array<{
			onComplete?: () => void;
			onError?: (error: Error) => void;
		}> = [];
		let size = 60_000;
		const ctx = context(
			() => size,
			(options) => ended.push(options),
		);
		await handlers.get("session_start")?.({}, ctx);
		const turnEnd = (turn: object) =>
			endTurn((name, event, at) => handlers.get(name)?.(event, at), turn, ctx);
		await turnEnd({ toolResults: [{}] });
		size = 900_000;
		for (let turn = 0; turn < 200 && ended.length === 0; turn++) {
			await turnEnd({ toolResults: [{}] });
		}
		const options = ended[0];
		if (options === undefined) throw new Error("the policy never compacted");

		stale.now = true;

		expect(() =>
			options.onError?.(new Error("Summarization failed")),
		).not.toThrow();
		expect(() => options.onComplete?.()).not.toThrow();
	});

	it("resumes a run begun after the ask that the compaction cut", async () => {
		// 19 November, 13:39: a finished turn asked, a job's result started
		// a run a second later, and the compaction's abort cut it.
		const entries: unknown[] = [];
		const calls = await runUntilCompaction(
			(options) => {
				entries.push(aborted(Date.now() + 1000));
				options.onComplete?.();
			},
			() => entries,
			[],
		);

		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(RESUME_TEXT);
	});

	// pi's compaction aborts the run, and an abort leaves what was queued
	// for it; nothing else starts a run, so skipping the resume left the
	// session deaf to those messages until something new was typed.
	it("resumes a run the compaction cut though messages wait to go, which that run delivers", async () => {
		const entries: unknown[] = [];
		const calls = await runUntilCompaction(
			(options) => {
				entries.push(aborted(Date.now() + 1000));
				options.onComplete?.();
			},
			() => entries,
			[],
			{ hasPendingMessages: () => true },
		);

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([RESUME_TEXT]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: true, by: "asker" }),
		]);
	});

	it("starts a run for messages that waited through a compaction that cut nothing", async () => {
		const calls = await runUntilCompaction(
			(options) => options.onComplete?.(),
			() => [],
			[],
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			WAITING_TEXT,
		]);
		expect(calls.order.slice(-2), "settled before the send").toEqual([
			SETTLED_ENTRY,
			"send",
		]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "asker" }),
		]);
	});

	it("starts nothing for messages pi's screen sent as the compaction ended, whose run drained them", async () => {
		// pi's interactive screen sends what was typed during a compaction
		// at its end, before onComplete, and that run delivers the rest.
		let idle = true;
		let pending = false;
		const calls = await runUntilCompaction(
			(options) => {
				idle = false;
				pending = true;
				options.onComplete?.();
			},
			() => [],
			[],
			{ isIdle: () => idle, hasPendingMessages: () => pending },
		);
		expect(calls.sendUserMessage, "nothing while that run goes").toEqual([]);
		pending = false;
		idle = true;
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("starts nothing for waiting messages a prompt pi's screen began will deliver, though pi is still idle", async () => {
		// pi's prompt awaits its input handlers and its auth check before
		// it is busy, and the rest of what was typed is queued meanwhile.
		const calls = await runUntilCompaction(
			(options, handlers) => {
				input(handlers);
				options.onComplete?.();
			},
			() => [],
			[],
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "asker" }),
		]);
	});

	it("waits a moment before its first look, for a prompt whose input handlers are still running", async () => {
		// One loaded before this extension that awaits the disk holds back
		// the input this one hears.
		const calls = await runUntilCompaction(
			(options, handlers) => {
				options.onComplete?.();
				setTimeout(() => input(handlers), 200);
			},
			() => [],
			[],
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("starts a run for waiting messages though one was queued while pi streamed", async () => {
		// A message queued behind a run starts none, and the compaction cut
		// the run it was queued for.
		const calls = await runUntilCompaction(
			(options, handlers) => {
				input(handlers, "followUp");
				options.onComplete?.();
			},
			() => [],
			[],
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			WAITING_TEXT,
		]);
	});

	it("leaves its landing unsettled until the run for waiting messages is decided, for a reload's successor", async () => {
		const calls = await runUntilCompaction(
			(options) => options.onComplete?.(),
			() => [],
			[],
			{ hasPendingMessages: () => true },
		);
		expect(appended(calls, SETTLED_ENTRY), "nothing settled yet").toEqual([]);
		await settles();

		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "asker" }),
		]);
	});

	it("settles quietly when pi stays busy past the wait for waiting messages, as a run going delivers them", async () => {
		const written: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			});
		let idle = true;
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		try {
			const calls = await runUntilCompaction(
				(options) => {
					idle = false;
					options.onComplete?.();
				},
				() => [],
				[],
				{ isIdle: () => idle, hasPendingMessages: () => true },
			);
			await vi.advanceTimersByTimeAsync(61_000);

			expect(calls.sendUserMessage).toEqual([]);
			expect(written).toEqual([]);
			expect(appended(calls, SETTLED_ENTRY)).toEqual([
				expect.objectContaining({ resumed: false, by: "asker" }),
			]);
		} finally {
			vi.useRealTimers();
			spy.mockRestore();
		}
	});

	it("starts a run for messages that waited through a failed compaction that cut nothing", async () => {
		const calls = await runUntilCompaction(
			(options) => options.onError?.(new Error("Summarization failed")),
			() => [],
			[],
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			FAILED_WAITING_TEXT,
		]);
	});

	it("starts nothing for waiting messages after a cancelled compaction, which somebody stopped", async () => {
		const entries: unknown[] = [];
		const calls = await runUntilCompaction(
			(options) => {
				entries.push(aborted(Date.now() + 1000));
				options.onError?.(new Error("Compaction cancelled"));
			},
			() => entries,
			[],
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("resumes a run a failed compaction cut though messages wait to go", async () => {
		const entries: unknown[] = [];
		const calls = await runUntilCompaction(
			(options) => {
				entries.push(aborted(Date.now() + 1000));
				options.onError?.(new Error("Summarization failed"));
			},
			() => entries,
			[],
			{ hasPendingMessages: () => true },
		);

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			FAILED_RESUME_TEXT,
		]);
	});

	it("leaves a run stopped before the ask stopped", async () => {
		const entries: unknown[] = [aborted(Date.now() - 60_000)];
		const calls = await runUntilCompaction(
			(options) => options.onComplete?.(),
			() => entries,
			[],
		);

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("records each ask, so another runtime can tell what is owed", async () => {
		const calls = await runUntilCompaction(() => {});

		const asks = calls.appendEntry.filter(([type]) => type === ASKED_ENTRY);
		expect(asks).toHaveLength(1);
		expect(asks[0]?.[1]).toMatchObject({ resume: true });
	});

	it("settles each ask it answers, resumed or not", async () => {
		const resumed = await runUntilCompaction((options) =>
			options.onComplete?.(),
		);
		const cancelled = await runUntilCompaction((options) =>
			options.onError?.(new Error("Compaction cancelled")),
		);

		expect(appended(resumed, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: true, by: "asker" }),
		]);
		expect(resumed.order.slice(-2), "settled before the send").toEqual([
			SETTLED_ENTRY,
			"send",
		]);
		expect(appended(cancelled, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "asker" }),
		]);
		expect(cancelled.sendUserMessage).toEqual([]);
	});

	it("resumes a run begun after the ask that a failed compaction cut", async () => {
		const entries: unknown[] = [];
		const calls = await runUntilCompaction(
			(options) => {
				entries.push(aborted(Date.now() + 1000));
				options.onError?.(new Error("Summarization failed"));
			},
			() => entries,
			[],
		);

		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(FAILED_RESUME_TEXT);
		expect(calls.order.slice(-2), "settled before the send").toEqual([
			SETTLED_ENTRY,
			"send",
		]);
	});

	it("answers its own landing once, though pi awaits between the two", async () => {
		// pi emits session_compact, awaits the work item's end, and only
		// then calls onComplete: a check from the log meanwhile would see
		// the ask unsettled and resume it a second time.
		const { handlers, calls } = activate();
		const ended: Array<{ onComplete?: () => void }> = [];
		let size = 60_000;
		const branch = () => [
			...appended(calls, ASKED_ENTRY).map((data) => askEntry(Date.now(), data)),
			compactionEntry(Date.now()),
		];
		const ctx = context(
			() => size,
			(options) => ended.push(options),
			branch,
		);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const turnEnd = (turn: object) =>
			endTurn((name, event, at) => handlers.get(name)?.(event, at), turn, ctx);
		await turnEnd({ toolResults: [{}] });
		size = 900_000;
		for (let turn = 0; turn < 200 && ended.length === 0; turn++) {
			await turnEnd({ toolResults: [{}] });
		}

		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		await nextTurn();
		ended[0]?.onComplete?.();

		expect(calls.sendUserMessage).toHaveLength(1);
	});
});

describe("resuming from the log a run another runtime owed", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/** A log whose last compaction stopped a run going on, eight seconds ago. */
	const owing = (now = Date.now()) => [
		askEntry(now - 8000, { at: now - 8000, resume: true }),
		aborted(now - 7900),
		compactionEntry(now - 7800),
	];

	/** Start a runtime on `entries` and let its start finish. */
	const startOn = async (
		entries: unknown[],
		reason = "reload",
		changes: Record<string, unknown> = {},
		broken: { append?: Error } = {},
	) => {
		const { handlers, calls } = activate({ now: false }, broken);
		const ctx = {
			...context(
				() => 60_000,
				() => {},
				() => entries,
			),
			...changes,
		};
		await handlers.get("session_start")?.({ reason }, ctx);
		const duringStart = calls.sendUserMessage.length;
		await handlers.get("resources_discover")?.({ reason }, ctx);
		await nextTurn();
		return { handlers, calls, ctx, duringStart };
	};

	it("resumes once its start is done when the runtime that asked is gone", async () => {
		// 19 November, 08:08: a reload landed between the compaction's
		// abort and its end, and the stale runtime's resume went nowhere.
		const { calls, duringStart } = await startOn(owing());

		expect(duringStart, "nothing sent from session_start").toBe(0);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(RESUME_TEXT);
		expect(calls.order, "settled before the send").toEqual([
			SETTLED_ENTRY,
			"send",
		]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: true, by: "successor" }),
		]);
	});

	it("resumes on a host's or pi's start after it stopped", async () => {
		const { calls } = await startOn(owing(), "startup");

		expect(calls.sendUserMessage).toHaveLength(1);
	});

	it.each(["fork", "resume", "new"])(
		"starts nothing on a %s, which chose the log rather than came back to it",
		async (reason) => {
			const { calls } = await startOn(owing(), reason);

			expect(calls.sendUserMessage).toEqual([]);
		},
	);

	it("reads the ask the asking runtime wrote", async () => {
		// The asker's compaction never ends here, as when a reload replaced
		// it: what it wrote is all the next runtime has.
		const asker = await runUntilCompaction(() => {});
		const [ask] = appended(asker, ASKED_ENTRY);
		const now = Date.now();

		const { calls } = await startOn([
			askEntry(now, ask),
			aborted(now + 100),
			compactionEntry(now + 200),
		]);

		expect(calls.sendUserMessage).toHaveLength(1);
	});

	it("resumes once a compaction another runtime asked for lands after its start", async () => {
		// The reload ran while the compaction summarised, so its start saw
		// nothing owed yet.
		const now = Date.now();
		const entries: unknown[] = [
			askEntry(now - 8000, { at: now - 8000, resume: true }),
			aborted(now - 7900),
		];
		const { handlers, calls, ctx } = await startOn(entries);
		expect(calls.sendUserMessage, "nothing owed at start").toEqual([]);

		entries.push(compactionEntry(now));
		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		expect(calls.sendUserMessage, "nothing while compacting").toEqual([]);
		await nextTurn();

		expect(calls.sendUserMessage).toHaveLength(1);
	});

	it("waits for pi to be idle after a landing, however long its handlers take", async () => {
		// pi is compacting until every session_compact handler returns, and
		// one that awaits the disk holds it past the next turn of the loop.
		const now = Date.now();
		const entries: unknown[] = [
			askEntry(now - 8000, { at: now - 8000, resume: true }),
			aborted(now - 7900),
		];
		let idle = true;
		const { handlers, calls, ctx } = await startOn(entries, "reload", {
			isIdle: () => idle,
		});

		idle = false;
		entries.push(compactionEntry(now));
		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		await nextTurn();
		expect(calls.sendUserMessage, "nothing while compacting").toEqual([]);
		idle = true;
		await nextLook();

		expect(calls.sendUserMessage).toHaveLength(1);
	});

	it("starts nothing once a run under way has answered", async () => {
		const entries = owing();
		let idle = false;
		const { calls } = await startOn(entries, "reload", {
			isIdle: () => idle,
		});
		expect(calls.sendUserMessage, "nothing while it runs").toEqual([]);

		entries.push(finished(Date.now()));
		idle = true;
		await nextLook();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("resumes a run cut by a compaction that failed after the asker was gone", async () => {
		const now = Date.now();
		const entries = [
			askEntry(now - 8000, { at: now - 8000, resume: false }),
			aborted(now - 7900),
		];
		const { handlers, calls, ctx } = await startOn(entries);

		await handlers.get("session_compact_failed")?.({ aborted: false }, ctx);
		await nextTurn();

		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(FAILED_RESUME_TEXT);
		expect(calls.order).toEqual([SETTLED_ENTRY, "send"]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: true, by: "successor" }),
		]);
	});

	it("settles, resuming nothing, a compaction cancelled after the asker was gone", async () => {
		const now = Date.now();
		const { handlers, calls, ctx } = await startOn([
			askEntry(now - 8000, { at: now - 8000, resume: true }),
			aborted(now - 7900),
		]);

		await handlers.get("session_compact_failed")?.({ aborted: true }, ctx);
		await nextTurn();

		expect(calls.sendUserMessage).toEqual([]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "successor" }),
		]);
	});

	it("starts a run for messages waiting through a failure after the asker was gone that cut nothing", async () => {
		const now = Date.now();
		const pending = { hasPendingMessages: () => true };
		const { handlers, calls, ctx } = await startOn(
			[askEntry(now - 8000, { at: now - 8000, resume: false })],
			"reload",
			pending,
		);

		await handlers.get("session_compact_failed")?.({ aborted: false }, ctx);
		await nextTurn();
		await settles();

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			FAILED_WAITING_TEXT,
		]);
	});

	it("starts nothing for waiting messages after a cancel after the asker was gone", async () => {
		const now = Date.now();
		const { handlers, calls, ctx } = await startOn(
			[askEntry(now - 8000, { at: now - 8000, resume: false })],
			"reload",
			{ hasPendingMessages: () => true },
		);

		await handlers.get("session_compact_failed")?.({ aborted: true }, ctx);
		await nextTurn();
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("starts a run for messages waiting through a landing after the asker was gone that owed nothing", async () => {
		const now = Date.now();
		const entries: unknown[] = [
			askEntry(now - 8000, { at: now - 8000, resume: false }),
		];
		const { handlers, calls, ctx } = await startOn(entries, "reload", {
			hasPendingMessages: () => true,
		});
		expect(calls.sendUserMessage, "nothing owed at start").toEqual([]);

		entries.push(compactionEntry(now));
		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		await nextTurn();
		await settles();

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			WAITING_TEXT,
		]);
		expect(calls.order, "settled before the send").toEqual([
			SETTLED_ENTRY,
			"send",
		]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "successor" }),
		]);
	});

	it("starts a run for messages waiting on a reload's start after a landing its asker never answered", async () => {
		// The compaction landed during the reload, between session_compact
		// and the asker's onComplete, which went with its runtime.
		const now = Date.now();
		const { calls, duringStart } = await startOn(
			[
				askEntry(now - 8000, { at: now - 8000, resume: false }),
				compactionEntry(now - 100),
			],
			"reload",
			{ hasPendingMessages: () => true },
		);
		await settles();

		expect(duringStart, "nothing sent from session_start").toBe(0);
		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([
			WAITING_TEXT,
		]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "successor" }),
		]);
	});

	it("starts nothing for waiting messages after a landing nobody asked for", async () => {
		// pi's own compaction goes on to a turn for queued messages itself
		// (_runAutoCompaction answers hasQueuedMessages), so one from here
		// would be a second.
		const now = Date.now();
		const entries: unknown[] = [finished(now - 9000)];
		const { handlers, calls, ctx } = await startOn(entries, "reload", {
			hasPendingMessages: () => true,
		});

		entries.push(compactionEntry(now));
		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		await nextTurn();
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("starts nothing for waiting messages after a landing its asker answered", async () => {
		const now = Date.now();
		const entries: unknown[] = [
			askEntry(now - 8000, { at: now - 8000, resume: false }),
			compactionEntry(now - 100),
			settledEntry(now - 50),
		];
		const { handlers, calls, ctx } = await startOn(entries, "reload", {
			hasPendingMessages: () => true,
		});

		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		await nextTurn();
		await settles();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("resumes on a start after pi stopped while the summary was written", async () => {
		// The compaction neither landed nor failed, so nothing else answers
		// its ask: the host was down for twenty minutes.
		const now = Date.now();
		const { calls } = await startOn(
			[
				askEntry(now - 20 * 60_000, { at: now - 20 * 60_000, resume: true }),
				aborted(now - 20 * 60_000 + 100),
			],
			"startup",
		);

		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(FAILED_RESUME_TEXT);
		expect(calls.order, "settled before the send").toEqual([
			SETTLED_ENTRY,
			"send",
		]);
	});

	it("leaves an unlanded ask to its compaction on a reload", async () => {
		// The old runtime's compaction may still be summarising, and lands
		// after this start.
		const now = Date.now();
		const { calls } = await startOn([
			askEntry(now - 8000, { at: now - 8000, resume: true }),
			aborted(now - 7900),
		]);

		expect(calls.sendUserMessage).toEqual([]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([]);
	});

	it("settles, resuming nothing, an unlanded ask from an idle turn on a start", async () => {
		const now = Date.now();
		const { calls } = await startOn(
			[
				finished(now - 8100),
				askEntry(now - 8000, { at: now - 8000, resume: false }),
			],
			"startup",
		);

		expect(calls.sendUserMessage).toEqual([]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: false, by: "successor" }),
		]);
	});

	it("resumes nothing after a failure once the run since has finished", async () => {
		// The person took over while pi was busy, and their run ended.
		const now = Date.now();
		const entries: unknown[] = [
			askEntry(now - 8000, { at: now - 8000, resume: true }),
			aborted(now - 7900),
		];
		let idle = false;
		const { handlers, calls, ctx } = await startOn(entries, "reload", {
			isIdle: () => idle,
		});

		await handlers.get("session_compact_failed")?.({ aborted: false }, ctx);
		await nextTurn();
		entries.push(finished(Date.now()));
		idle = true;
		await nextLook();

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("says why, rather than taking pi down, when the log can't be written", async () => {
		const written: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			});
		try {
			const { calls } = await startOn(
				owing(),
				"reload",
				{},
				{
					append: new Error("ENOSPC: no space left on device"),
				},
			);

			expect(calls.sendUserMessage).toEqual([]);
			expect(written).toEqual([
				"compaction-workflow: couldn't start the run a compaction owed: ENOSPC: no space left on device\n",
			]);
		} finally {
			spy.mockRestore();
		}
	});

	it("says so when pi stays busy past the wait", async () => {
		const written: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			});
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		try {
			const { calls } = await startOn(owing(), "reload", {
				isIdle: () => false,
			});
			await vi.advanceTimersByTimeAsync(61_000);

			expect(calls.sendUserMessage).toEqual([]);
			expect(written).toEqual([
				"compaction-workflow: pi stayed busy for 60 s, so the run a compaction owed wasn't started\n",
			]);
		} finally {
			vi.useRealTimers();
			spy.mockRestore();
		}
	});

	it("resumes though a message waits to go, which only a run delivers", async () => {
		const { calls } = await startOn(owing(), "reload", {
			hasPendingMessages: () => true,
		});

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([RESUME_TEXT]);
		expect(appended(calls, SETTLED_ENTRY)).toEqual([
			expect.objectContaining({ resumed: true, by: "successor" }),
		]);
	});

	it("resumes once, not for the waiting messages too, on a landing that owes a run", async () => {
		const now = Date.now();
		const entries: unknown[] = [
			askEntry(now - 8000, { at: now - 8000, resume: true }),
			aborted(now - 7900),
		];
		const { handlers, calls, ctx } = await startOn(entries, "reload", {
			hasPendingMessages: () => true,
		});

		entries.push(compactionEntry(now));
		await handlers.get("session_compact")?.({ compactionEntry: {} }, ctx);
		await nextTurn();

		expect(calls.sendUserMessage.map((call) => call[0])).toEqual([RESUME_TEXT]);
	});

	it("starts nothing in a mode that is never resumed", async () => {
		const { calls } = await startOn(owing(), "reload", { mode: "json" });

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("starts nothing with the policy off", async () => {
		vi.stubEnv("PI_COMPACTION_POLICY", "off");
		const { calls } = await startOn(owing());

		expect(calls.sendUserMessage).toEqual([]);
	});
});

describe("resuming after a failed compaction", () => {
	it("resumes after a failed compaction through the prompt path", async () => {
		const calls = await runUntilCompaction((options) =>
			options.onError?.(new Error("Summarization failed")),
		);

		expect(calls.sendMessage).toEqual([]);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toBe(FAILED_RESUME_TEXT);
	});
});
