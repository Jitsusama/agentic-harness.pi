/**
 * Two `spend` calls at once.
 *
 * Every call indexes the session logs before it answers, and parallel
 * tool calls or a codemode script's Promise.all start two at the same
 * moment. They shared one SQLite connection, so the second pass's BEGIN
 * landed inside the first's transaction and SQLite refused it: "cannot
 * start a transaction within a transaction", three times in two days.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import spendWorkflow from "../../../extensions/spend-workflow/index.ts";
import { PASS_STOPPED } from "../../../extensions/spend-workflow/indexer.ts";
import { claimLease } from "../../../extensions/spend-workflow/keeper.ts";
import { cleanupSessionResults } from "../../../lib/core/result/location.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { resultSession } from "../../support/result-session.ts";

const ctx = resultSession();

interface Tool {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		context: typeof ctx,
	): Promise<{ content: { text: string }[] }>;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

const saved = {
	agent: process.env.PI_CODING_AGENT_DIR,
	state: process.env.XDG_STATE_HOME,
};
let dir: string;
let handlers: Map<string, Handler[]>;

function restore(
	name: "PI_CODING_AGENT_DIR" | "XDG_STATE_HOME",
	value?: string,
) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** One session log with a few billed turns in it. */
function aSessionLog(sessions: string, name = "01a0aaaa-0000"): void {
	const session = join(sessions, "--work--");
	mkdirSync(session, { recursive: true });
	const lines = Array.from({ length: 40 }, (_, i) =>
		JSON.stringify({
			id: `e${i}`,
			type: "message",
			timestamp: `2026-10-01T21:46:${String(i).padStart(2, "0")}.000Z`,
			message: {
				role: "assistant",
				model: "claude-opus-5",
				usage: { input: 1, output: 1, cost: { total: 0.01 } },
				content: [
					{
						type: "toolCall",
						id: `c${i}`,
						name: "bash",
						arguments: { command: `ls ${i}` },
					},
				],
			},
		}),
	);
	writeFileSync(
		join(session, `2026-10-01T21-46-00-000Z_${name}.jsonl`),
		`${lines.join("\n")}\n`,
	);
}

function costTool(): Tool {
	let found: Tool | undefined;
	handlers = new Map();
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool: (definition: Tool) => {
			found = definition;
		},
		registerCommand: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	spendWorkflow(pi as never);
	if (!found) throw new Error("the spend tool was not registered");
	return found;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cost-concurrent-"));
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.XDG_STATE_HOME = join(dir, "state");
	aSessionLog(join(dir, "agent", "sessions"));
});

afterEach(async () => {
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({}, {});
	}
	cleanupSessionResults(ctx);
	restore("PI_CODING_AGENT_DIR", saved.agent);
	restore("XDG_STATE_HOME", saved.state);
	rmSync(dir, { recursive: true, force: true });
});

describe("cost calls made at the same moment", () => {
	it("all answer, sharing one pass over the logs", async () => {
		const tool = costTool();
		const answers = await Promise.allSettled([
			tool.execute("a", { reindex: true }, undefined, undefined, ctx),
			tool.execute("b", { reindex: true }, undefined, undefined, ctx),
			tool.execute("c", {}, undefined, undefined, ctx),
		]);

		expect(answers.map((answer) => answer.status)).toEqual([
			"fulfilled",
			"fulfilled",
			"fulfilled",
		]);
	});

	it("stop a pass under way at shutdown before closing the ledger under it", async () => {
		// On 25 November a keeper's pass of 24 minutes ended in SQLITE_MISUSE,
		// its handle closed under it by the session's shutdown.
		const tool = costTool();
		await tool.execute("warm", {}, undefined, undefined, ctx);
		for (let n = 1; n <= 10; n += 1) {
			aSessionLog(join(dir, "agent", "sessions"), `01a0aaaa-${n}`);
		}

		const passing = tool
			.execute("a", { reindex: true }, undefined, undefined, ctx)
			.then(
				(answer) => answer.content[0]?.text ?? "",
				(error: unknown) => (error instanceof Error ? error.message : ""),
			);
		let ended = false;
		void passing.finally(() => {
			ended = true;
		});
		await new Promise((started) => setImmediate(started));
		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({}, {});
		}
		await Promise.resolve();

		expect(ended, "the pass had ended once shutdown was done").toBe(true);
		expect(await passing, "how the pass ended").toBe(PASS_STOPPED);
		await expect(
			tool.execute("after", {}, undefined, undefined, ctx),
			"a call once the session has ended",
		).rejects.toThrow("The ledger is closed");
	}, 30_000);

	it("read the ledger as it stands while another pass holds it", async () => {
		const observability = stateDir("observability");
		mkdirSync(observability, { recursive: true });
		const release = claimLease(observability);
		try {
			const answer = await costTool().execute(
				"a",
				{ reindex: true },
				undefined,
				undefined,
				ctx,
			);

			expect(answer.content[0]?.text).toContain("holds the ledger");
		} finally {
			release?.();
		}
	});

	it("index each log once between them", async () => {
		const tool = costTool();
		const [first, second] = await Promise.all([
			tool.execute("a", { reindex: true }, undefined, undefined, ctx),
			tool.execute("b", { reindex: true }, undefined, undefined, ctx),
		]);
		expect(first?.content[0]?.text).toBe(second?.content[0]?.text);
	});
});
