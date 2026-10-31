/**
 * The rollover workflow driven through the events pi emits: a
 * compaction of a large log marks it due, the next still moment hands
 * it to the command, and the command switches to a fresh log that
 * carries the session's spend. pi's `switchSession` is played by
 * opening the fresh log and starting the extensions on it, which is
 * what a switch does.
 */

import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	type EventBus,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import rolloverWorkflow, {
	COMMAND,
} from "../../../extensions/rollover-workflow/index.ts";
import spendWorkflow, {
	COST_READING,
} from "../../../extensions/spend-workflow/index.ts";
import {
	ROLLOVER_BYTES,
	ROLLOVER_ENV,
	rolledFrom,
} from "../../../lib/internal/session/rollover.ts";
import { announceJobHost } from "../../../lib/jobs/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Command {
	handler: (args: string, ctx: unknown) => Promise<void>;
}

let dir: string;
let events: EventBus;
let handlers: Map<string, Handler[]>;
let command: Command | undefined;
let sent: string[];
let spend: number;
const saved = process.env[ROLLOVER_ENV];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rollover-wiring-"));
	events = createEventBus();
	handlers = new Map();
	command = undefined;
	sent = [];
	spend = 0;
	delete process.env[ROLLOVER_ENV];
	const pi = {
		events,
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: (name: string, definition: Command) => {
			if (name === COMMAND) command = definition;
		},
		registerTool: () => {},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
		setModel: async () => true,
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
	};
	rolloverWorkflow(pi as never);
	spendWorkflow(pi as never);
	events.on(COST_READING, (data) => {
		spend = (data as { session: number }).session;
	});
});

afterEach(async () => {
	await emit("session_shutdown", {}, {});
	if (saved === undefined) delete process.env[ROLLOVER_ENV];
	else process.env[ROLLOVER_ENV] = saved;
	rmSync(dir, { recursive: true, force: true });
});

async function emit(name: string, event: unknown, ctx: unknown) {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

const user = (text: string) => ({
	role: "user" as const,
	content: text,
	timestamp: Date.now(),
});

const assistant = (cost: number) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "done" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	},
	stopReason: "stop" as const,
	timestamp: Date.now(),
});

/** A compacted session that spent $1 before its kept tail and $2 in it. */
function compacted(): SessionManager {
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage(user("early"));
	manager.appendMessage(assistant(1));
	const kept = manager.appendMessage(user("kept"));
	manager.appendMessage(assistant(2));
	manager.appendCompaction("early work", kept, 100);
	return manager;
}

/** Make the log read as large without writing that much. */
function large(manager: SessionManager): void {
	truncateSync(manager.getSessionFile() ?? "", ROLLOVER_BYTES);
}

function contextOf(manager: SessionManager, idle = true) {
	return {
		hasUI: true,
		sessionManager: manager,
		isIdle: () => idle,
		model: { provider: "anthropic", id: "claude" },
		modelRegistry: { find: () => undefined },
		ui: { notify: () => {} },
	};
}

/** A command context whose switch opens the log and starts extensions on it. */
function commandContext(manager: SessionManager) {
	const switched: SessionManager[] = [];
	const notices: string[] = [];
	const ctx = {
		...contextOf(manager),
		waitForIdle: async () => {},
		ui: { notify: (text: string) => notices.push(text) },
		switchSession: async (
			path: string,
			options?: { withSession?: (fresh: unknown) => Promise<void> },
		) => {
			await emit("session_shutdown", { reason: "resume" }, ctx);
			const fresh = SessionManager.open(path);
			switched.push(fresh);
			const freshCtx = { ...contextOf(fresh), ui: ctx.ui };
			await emit("session_start", { reason: "resume" }, freshCtx);
			await options?.withSession?.(freshCtx);
			return { cancelled: false };
		},
	};
	return { ctx, switched, notices };
}

describe("rolling over by itself", () => {
	it("happens at the first settle after a large log's compaction", async () => {
		const manager = compacted();
		large(manager);
		await emit("session_compact", {}, contextOf(manager, false));
		expect(sent).toEqual([]);

		await emit("agent_settled", { aborted: false }, contextOf(manager));
		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("happens at once for a compaction asked for between runs", async () => {
		const manager = compacted();
		large(manager);
		await emit("session_compact", {}, contextOf(manager, true));

		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("waits for a log under the threshold to grow", async () => {
		const manager = compacted();
		await emit("session_compact", {}, contextOf(manager));
		await emit("agent_settled", { aborted: false }, contextOf(manager));

		expect(sent).toEqual([]);
	});

	it("waits past a run the person stopped, and past running jobs", async () => {
		const manager = compacted();
		large(manager);
		let pending = 1;
		const stop = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => pending,
		});
		await emit("session_compact", {}, contextOf(manager, false));
		await emit("agent_settled", { aborted: true }, contextOf(manager));
		await emit("agent_settled", { aborted: false }, contextOf(manager));
		expect(sent).toEqual([]);

		pending = 0;
		await emit("agent_settled", { aborted: false }, contextOf(manager));
		stop();
		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("never happens in a session nobody sits at, or when turned off", async () => {
		const manager = compacted();
		large(manager);
		await emit("session_compact", {}, { ...contextOf(manager), hasUI: false });
		process.env[ROLLOVER_ENV] = "off";
		await emit("session_compact", {}, contextOf(manager));

		expect(sent).toEqual([]);
	});
});

describe("the command", () => {
	it("switches to a fresh log that carries the session's spend", async () => {
		const manager = compacted();
		await emit("session_start", { reason: "startup" }, contextOf(manager));
		expect(spend).toBe(3);
		const { ctx, switched, notices } = commandContext(manager);

		await command?.handler("", ctx);

		const fresh = switched[0];
		expect(fresh?.getHeader()?.parentSession).toBe(manager.getSessionFile());
		expect(rolledFrom(fresh?.getBranch() ?? [])?.carried).toEqual({
			"cost-workflow": { spend: 3 },
		});
		expect(spend).toBe(3);
		expect(notices).toEqual([expect.stringMatching(/^Rolled this session/)]);
	});

	it("counts what the fresh log spends on top of what it carried", async () => {
		const manager = compacted();
		await emit("session_start", { reason: "startup" }, contextOf(manager));
		const { ctx, switched } = commandContext(manager);
		await command?.handler("", ctx);
		const fresh = switched[0] as SessionManager;
		fresh.appendMessage(user("more"));
		fresh.appendMessage(assistant(4));

		await emit("session_start", { reason: "reload" }, contextOf(fresh));
		expect(spend).toBe(7);
	});

	it("says why it did not, for a session with no compaction", async () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("question"));
		manager.appendMessage(assistant(1));
		const { ctx, switched, notices } = commandContext(manager);

		await command?.handler("", ctx);

		expect(switched).toEqual([]);
		expect(notices).toEqual([expect.stringMatching(/^Nothing to roll over/)]);
	});
});
