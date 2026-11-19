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
import { ASKED_ENTRY, SETTLED_ENTRY } from "../../../lib/compaction/resume.ts";
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
function activate(stale = { now: false }): {
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
 * unless `toolResults` says they made none.
 */
async function runUntilCompaction(
	outcome: Parameters<typeof context>[1],
	branch?: () => unknown[],
	toolResults: unknown[] = [{}],
): Promise<Recorded> {
	const { handlers, calls } = activate();
	let size = 60_000;
	let compacted = false;
	const ctx = context(
		() => size,
		(options) => {
			compacted = true;
			outcome(options);
		},
		branch,
	);
	await handlers.get("session_start")?.({}, ctx);
	const turnEnd = (turn: object) =>
		endTurn((name, event, at) => handlers.get(name)?.(event, at), turn, ctx);
	await turnEnd({ toolResults });
	size = 900_000;
	for (let turn = 0; turn < 200 && !compacted; turn++) {
		await turnEnd({ toolResults });
	}
	if (!compacted) throw new Error("the policy never compacted");
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

/** One turn of the loop, after which a deferred check has run. */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Long enough for a check waiting on pi's idle to look again. */
const nextLook = () =>
	// A check that found pi busy looks again a quarter-second on.
	new Promise((resolve) => setTimeout(resolve, 400));

/** The entries of a type a runtime appended. */
const appended = (calls: Recorded, type: string) =>
	calls.appendEntry.filter(([written]) => written === type).map(([, d]) => d);

describe("resuming the run a compaction interrupted", () => {
	it("resumes after a compaction through the prompt path", async () => {
		const calls = await runUntilCompaction((options) => options.onComplete?.());

		expect(calls.sendMessage).toEqual([]);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/compacted/);
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
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/compacted/);
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
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/failed/);
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
	) => {
		const { handlers, calls } = activate();
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
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/compacted/);
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
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/failed/);
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

	it("starts nothing with a message waiting to go", async () => {
		const { calls } = await startOn(owing(), "reload", {
			hasPendingMessages: () => true,
		});

		expect(calls.sendUserMessage).toEqual([]);
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
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/failed/);
	});
});
