/**
 * The rollover workflow driven through the events pi emits: a
 * compaction of a large log marks it due, the next still moment hands
 * it to the command, and the command switches to a fresh log that
 * carries the session's spend. pi's `switchSession` is played by
 * opening the fresh log and starting the extensions on it, which is
 * what a switch does.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createEventBus,
	type EventBus,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// spend-workflow's footer asks spend-watch where the budgets stand; this
// test is about the log it rolls to, so the machine's spend-watch isn't run.
vi.mock("../../../lib/internal/spend-watch-budgets.ts", async (original) => ({
	...(await original<object>()),
	askBudgets: async () => undefined,
}));

import rolloverWorkflow, {
	COMMAND,
} from "../../../extensions/rollover-workflow/index.ts";
import spendWorkflow, {
	COST_READING,
} from "../../../extensions/spend-workflow/index.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import {
	isRestartAsk,
	RESTART_ASK,
	type RestartAsk,
} from "../../../lib/internal/session/park.ts";
import {
	ROLLOVER_BYTES,
	ROLLOVER_ENV,
	rolledFrom,
	rolloverSwitch,
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
	process.env[ROLLOVER_ENV] = "on";
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
	rmSync(rolloverSwitch(), { force: true });
	rmSync(dir, { recursive: true, force: true });
});

/** Write the switch that sessions already running read at a compaction. */
function switchSays(...lines: string[]): void {
	mkdirSync(dirname(rolloverSwitch()), { recursive: true });
	writeFileSync(rolloverSwitch(), `${lines.join("\n")}\n`);
}

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
		ui: { notify: () => {}, setStatus: () => {} },
	};
}

/** A command context whose switch opens the log and starts extensions on it. */
function commandContext(manager: SessionManager) {
	const switched: SessionManager[] = [];
	const notices: string[] = [];
	const ctx = {
		...contextOf(manager),
		waitForIdle: async () => {},
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: () => {},
		},
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

	it("waits past a run the person stopped", async () => {
		const manager = compacted();
		large(manager);
		await emit("session_compact", {}, contextOf(manager, false));
		await emit("agent_settled", { aborted: true }, contextOf(manager));
		expect(sent).toEqual([]);

		await emit("agent_settled", { aborted: false }, contextOf(manager));
		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("happens after a reload that took the still moment it waited for", async () => {
		// On 2026-11-06 a session compacted while an install's reload
		// waited; the reload went first and started the extension afresh,
		// so the roll was forgotten until the next compaction.
		const manager = compacted();
		large(manager);
		const slot = reloadSlot();
		slot.request = { reason: "the install moved", by: "self" };
		try {
			await emit("session_compact", {}, contextOf(manager, false));
			await emit("agent_settled", { aborted: false }, contextOf(manager));
			expect(sent).toEqual([]);
		} finally {
			slot.request = undefined;
		}

		await emit("session_start", { reason: "reload" }, contextOf(manager));
		await emit("agent_settled", { aborted: false }, contextOf(manager));
		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("waits after a reload for a log with no compaction, or one too small", async () => {
		const uncompacted = SessionManager.create(dir, dir);
		uncompacted.appendMessage(user("early"));
		uncompacted.appendMessage(assistant(1));
		large(uncompacted);
		await emit("session_start", { reason: "reload" }, contextOf(uncompacted));
		await emit("agent_settled", { aborted: false }, contextOf(uncompacted));

		const small = compacted();
		await emit("session_start", { reason: "reload" }, contextOf(small));
		await emit("agent_settled", { aborted: false }, contextOf(small));

		expect(sent).toEqual([]);
	});

	it("goes ahead while background jobs run, since they carry across", async () => {
		// A session waiting on its checks in the background always had one
		// running: on 2026-11-01 a 70 MB log went nine hours and three
		// compactions past the threshold without rolling over.
		const manager = compacted();
		large(manager);
		const stop = announceJobHost(events, {
			start: () => {
				throw new Error("not started here");
			},
			pending: () => 1,
		});
		await emit("session_compact", {}, contextOf(manager, false));
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

	it("happens for a large log when the switch turns it on, with nothing in the environment", async () => {
		const manager = compacted();
		large(manager);
		delete process.env[ROLLOVER_ENV];
		switchSays("on");
		await emit("session_compact", {}, contextOf(manager));

		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("happens for a small log the switch names, and for no other", async () => {
		const named = compacted();
		const other = compacted();
		delete process.env[ROLLOVER_ENV];
		switchSays(named.getSessionId());
		await emit("session_compact", {}, contextOf(other));
		expect(sent).toEqual([]);

		await emit("session_compact", {}, contextOf(named));
		expect(sent).toEqual([`/${COMMAND}`]);
	});

	it("never happens where the environment turns it off, whatever the switch says", async () => {
		const manager = compacted();
		large(manager);
		process.env[ROLLOVER_ENV] = "off";
		switchSays("on", manager.getSessionId());
		await emit("session_compact", {}, contextOf(manager));

		expect(sent).toEqual([]);
	});

	it("never happens by itself unless asked to, while a rolled session can lose its model", async () => {
		const manager = compacted();
		large(manager);
		delete process.env[ROLLOVER_ENV];
		await emit("session_compact", {}, contextOf(manager));
		await emit("agent_settled", { aborted: false }, contextOf(manager));

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

	it("stops a turn on the log it left, should that log start again", async () => {
		const manager = compacted();
		await emit("session_start", { reason: "startup" }, contextOf(manager));
		const { ctx, switched } = commandContext(manager);
		await command?.handler("", ctx);
		const stopped: string[] = [];
		const turnOn = (on: SessionManager, name: string) =>
			emit(
				"turn_start",
				{},
				{ ...contextOf(on), abort: () => stopped.push(name) },
			);

		await turnOn(SessionManager.open(manager.getSessionFile() ?? ""), "left");
		await turnOn(switched[0] as SessionManager, "fresh");

		expect(stopped).toEqual(["left"]);
	});

	it("leaves the switch to a new process when its holder will start the fresh log", async () => {
		const manager = compacted();
		await emit("session_start", { reason: "startup" }, contextOf(manager));
		const asked: RestartAsk[] = [];
		events.on(RESTART_ASK, (data) => {
			if (!isRestartAsk(data)) return;
			asked.push(data);
			data.restarting = true;
		});
		const { ctx, switched } = commandContext(manager);

		await command?.handler("", ctx);

		expect(switched).toEqual([]);
		const fresh = SessionManager.open(asked[0]?.sessionFile ?? "");
		expect(asked[0]?.session).toBe(manager.getSessionId());
		expect(fresh.getHeader()?.parentSession).toBe(manager.getSessionFile());
		expect(rolledFrom(fresh.getBranch())?.carried).toEqual({
			"cost-workflow": { spend: 3 },
		});
	});

	it("switches in this process when nothing will start it again", async () => {
		const manager = compacted();
		events.on(RESTART_ASK, (data) => {
			if (isRestartAsk(data)) data.why = "background jobs are out";
		});
		const { ctx, switched } = commandContext(manager);

		await command?.handler("", ctx);

		expect(switched).toHaveLength(1);
	});

	it("leaves the session a called-off switch stayed in to run", async () => {
		const manager = compacted();
		const { ctx } = commandContext(manager);
		ctx.switchSession = async () => ({ cancelled: true });
		await command?.handler("", ctx);
		const stopped: string[] = [];

		await emit(
			"turn_start",
			{},
			{ ...contextOf(manager), abort: () => stopped.push("stayed") },
		);

		expect(stopped).toEqual([]);
	});

	it("waits for a reload asked for or under way", async () => {
		const manager = compacted();
		const { ctx, switched, notices } = commandContext(manager);
		const slot = reloadSlot();
		slot.request = { reason: "the install moved", by: "self" };
		try {
			await command?.handler("", ctx);
		} finally {
			slot.request = undefined;
		}

		expect(switched).toEqual([]);
		expect(notices).toEqual([
			expect.stringMatching(/^Not rolled over: a reload/),
		]);
	});

	it("holds reloads off while it switches, and lets go after", async () => {
		const manager = compacted();
		const { ctx } = commandContext(manager);
		const during: (boolean | undefined)[] = [];
		const switchSession = ctx.switchSession;
		ctx.switchSession = async (path, options) => {
			during.push(reloadSlot().rolling);
			return switchSession(path, options);
		};

		await command?.handler("", ctx);

		expect(during).toEqual([true]);
		expect(reloadSlot()).toMatchObject({ rolling: false });
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
