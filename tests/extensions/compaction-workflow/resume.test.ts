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
import { describe, expect, it } from "vitest";
import compactionWorkflow from "../../../extensions/compaction-workflow/index.ts";
import { ASKED_ENTRY } from "../../../lib/compaction/resume.ts";
import { endTurn } from "../../support/turn-end.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Recorded {
	sendMessage: unknown[][];
	sendUserMessage: unknown[][];
	appendEntry: unknown[][];
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
		appendEntry: live((...args: unknown[]) => calls.appendEntry.push(args)),
		registerCommand: () => {},
		sendMessage: live((...args: unknown[]) => calls.sendMessage.push(args)),
		sendUserMessage: live((...args: unknown[]) =>
			calls.sendUserMessage.push(args),
		),
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
		message: { role: "assistant", stopReason: "error", content: [] },
	};
}

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

	it("resumes on starting again when the runtime that asked is gone", async () => {
		// 19 November, 08:08: a reload landed between the compaction's
		// abort and its end, and the stale runtime's resume went nowhere.
		const now = Date.now();
		const entries = [
			{
				type: "custom",
				customType: ASKED_ENTRY,
				timestamp: new Date(now - 8000).toISOString(),
				data: { at: now - 8000, resume: true },
			},
			aborted(now - 7900),
			{ type: "compaction", timestamp: new Date(now - 7800).toISOString() },
		];
		const { handlers, calls } = activate();
		const ctx = context(
			() => 60_000,
			() => {},
			() => entries,
		);

		await handlers.get("session_start")?.({ reason: "reload" }, ctx);

		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/compacted/);
	});

	it("starts nothing on starting again while a run is under way", async () => {
		const now = Date.now();
		const entries = [
			{
				type: "custom",
				customType: ASKED_ENTRY,
				timestamp: new Date(now - 8000).toISOString(),
				data: { at: now - 8000, resume: true },
			},
			{ type: "compaction", timestamp: new Date(now - 7800).toISOString() },
		];
		const { handlers, calls } = activate();
		const ctx = {
			...context(
				() => 60_000,
				() => {},
				() => entries,
			),
			isIdle: () => false,
		};

		await handlers.get("session_start")?.({ reason: "reload" }, ctx);

		expect(calls.sendUserMessage).toEqual([]);
	});

	it("resumes after a failed compaction through the prompt path", async () => {
		const calls = await runUntilCompaction((options) =>
			options.onError?.(new Error("Summarization failed")),
		);

		expect(calls.sendMessage).toEqual([]);
		expect(calls.sendUserMessage).toHaveLength(1);
		expect(String(calls.sendUserMessage[0]?.[0])).toMatch(/failed/);
	});
});
