import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexSessionLogs } from "../../../extensions/spend-workflow/indexer.ts";
import { RESUME_TEXT } from "../../../lib/compaction/resume.ts";
import {
	openLedgerReader,
	openTurnStore,
} from "../../../lib/core/observability/index.ts";

let scratch: string | null = null;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = null;
});

const CWD = "/home/someone/src/github.com/owner/repo";

let clock = Date.parse("2026-11-14T08:00:00.000Z");

function at(): string {
	clock += 60_000;
	return new Date(clock).toISOString();
}

function entry(
	id: string,
	parentId: string | null,
	fields: Record<string, unknown>,
): string {
	return JSON.stringify({ id, parentId, timestamp: at(), ...fields });
}

function assistant(
	id: string,
	parentId: string,
	calls: readonly { id: string; name: string; arguments: unknown }[] = [],
): string {
	return entry(id, parentId, {
		type: "message",
		message: {
			role: "assistant",
			model: "claude-opus-5",
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			usage: {
				input: 10,
				output: 20,
				cacheRead: 1000,
				cacheWrite: 100,
				cost: { total: 0.1 },
			},
			content: [
				{ type: "text", text: `turn ${id}` },
				...calls.map((call) => ({ type: "toolCall", ...call })),
			],
		},
	});
}

function result(id: string, parentId: string, callId: string): string {
	return entry(id, parentId, {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: callId,
			content: [{ type: "text", text: `result of ${callId}` }],
			isError: false,
		},
	});
}

function user(id: string, parentId: string, text: string): string {
	return entry(id, parentId, {
		type: "message",
		message: { role: "user", content: text },
	});
}

function compaction(id: string, parentId: string, firstKept: string): string {
	return entry(id, parentId, {
		type: "compaction",
		firstKeptEntryId: firstKept,
		tokensBefore: 200_000,
		summary: "what happened so far",
		details: { written: "ahead", summariser: "model", summaryMs: 900 },
		usage: { input: 5, output: 50, cost: { total: 0.05 } },
	});
}

/**
 * A log with every kind of state a scan carries from one line to the
 * next: thinking levels and bookings inherited through parents, a
 * branch taken from an old entry, calls answered after a compaction,
 * a gateway call's target, declarations, a side call, and compactions
 * whose resumption the next message settles.
 */
function richLog(): string[] {
	clock = Date.parse("2026-11-14T08:00:00.000Z");
	return [
		entry("s0", null, { type: "session", cwd: CWD }),
		entry("m1", "s0", { type: "model_change", model: "claude-opus-5" }),
		entry("l1", "m1", { type: "thinking_level_change", thinkingLevel: "high" }),
		entry("q1", "l1", {
			type: "custom",
			customType: "quest-workflow",
			data: { questId: "QEST-1", documentPath: "/q/PLAN-1.md", cwd: CWD },
		}),
		entry("y1", "q1", {
			type: "message",
			message: {
				role: "system",
				toolsAdded: [{ name: "bash", description: "runs a command" }],
			},
		}),
		user("u1", "y1", "look into it"),
		entry("v1", "u1", {
			type: "custom",
			customType: "provider-served",
			data: { backend: "anthropic-dev", account: "org/work" },
		}),
		assistant("a1", "v1", [
			{ id: "t1", name: "bash", arguments: { command: "ls" } },
		]),
		result("r1", "a1", "t1"),
		assistant("a2", "r1", [
			{ id: "g1", name: "tool_gateway_run_tool", arguments: { name: "x" } },
		]),
		result("r2", "a2", "g1"),
		assistant("a3", "r2", [
			{ id: "t2", name: "bash", arguments: { command: "pnpm test" } },
		]),
		compaction("c1", "a3", "a3"),
		user("u2", "c1", RESUME_TEXT),
		result("r3", "u2", "t2"),
		assistant("a4", "r3", [
			{ id: "t3", name: "read", arguments: { path: "/x.ts" } },
		]),
		entry("d1", "a4", {
			type: "custom",
			customType: "side-call",
			data: {
				model: "claude-haiku",
				usage: { input: 3, output: 4, cost: { total: 0.01 } },
			},
		}),
		user("u3", "a2", "go back and try another way"),
		assistant("a5", "u3"),
		compaction("c2", "a5", "a5"),
		assistant("a6", "c2"),
		entry("l2", "a6", { type: "thinking_level_change", thinkingLevel: "low" }),
		entry("y2", "l2", {
			type: "message",
			message: {
				role: "system",
				toolsAdded: [{ name: "read", description: "reads a file" }],
				toolsRemoved: ["bash"],
			},
		}),
		assistant("a7", "y2"),
		result("r4", "a4", "t3"),
	];
}

interface Place {
	readonly root: string;
	readonly log: string;
	readonly db: string;
	readonly watermarks: string;
}

function place(name: string): Place {
	if (!scratch) scratch = mkdtempSync(join(tmpdir(), "ledger-resume-"));
	const base = join(scratch, name);
	const dir = join(base, "sessions", "proj");
	mkdirSync(dir, { recursive: true });
	return {
		root: join(base, "sessions"),
		log: join(dir, "2026-11-14T08-00-00-000Z_one.jsonl"),
		db: join(base, "ledger.db"),
		watermarks: join(base, "watermarks.json"),
	};
}

async function pass(where: Place) {
	const store = await openTurnStore(where.db);
	try {
		return await indexSessionLogs(store, where.watermarks, where.root);
	} finally {
		await store.close();
	}
}

/** Where the indexer keeps what it carries between passes. */
function carried(where: Place): string {
	return join(where.watermarks, "..", "ledger-resume");
}

/** Forget what was carried, so the next pass reads the log whole. */
function forget(where: Place): void {
	rmSync(carried(where), { recursive: true, force: true });
}

const TABLES = [
	"SELECT * FROM turns ORDER BY digest",
	"SELECT * FROM sightings ORDER BY digest, session_id",
	"SELECT * FROM tool_calls ORDER BY digest",
	"SELECT * FROM inner_calls ORDER BY digest",
	"SELECT * FROM dropped_calls ORDER BY digest",
	"SELECT * FROM declarations ORDER BY session_id, entry_id, tool",
	"SELECT * FROM sessions ORDER BY session_id",
];

async function rows(where: Place): Promise<unknown[]> {
	const reader = await openLedgerReader(where.db);
	try {
		const answers: unknown[] = [];
		for (const sql of TABLES) answers.push((await reader.query(sql)).rows);
		return answers;
	} finally {
		await reader.close();
	}
}

function body(lines: readonly string[]): string {
	return lines.map((line) => `${line}\n`).join("");
}

describe("a grown log read from where the last pass stopped", () => {
	it("gives the ledger what a whole read gives, split at every line", async () => {
		const lines = richLog();
		for (let split = 1; split < lines.length; split += 1) {
			const resumed = place(`resumed-${split}`);
			const whole = place(`whole-${split}`);
			for (const where of [resumed, whole]) {
				writeFileSync(where.log, body(lines.slice(0, split)));
				await pass(where);
				appendFileSync(where.log, body(lines.slice(split)));
			}
			forget(whole);

			const outcome = await pass(resumed);
			await pass(whole);

			expect(outcome.resumed, `split at line ${split}`).toBe(1);
			expect(await rows(resumed), `split at line ${split}`).toEqual(
				await rows(whole),
			);
		}
	});

	it("resumes again and again as a log keeps growing", async () => {
		const lines = richLog();
		const resumed = place("resumed");
		const whole = place("whole");
		writeFileSync(resumed.log, "");
		writeFileSync(whole.log, "");
		for (const line of lines) {
			appendFileSync(resumed.log, `${line}\n`);
			appendFileSync(whole.log, `${line}\n`);
			await pass(resumed);
			forget(whole);
			await pass(whole);
		}

		expect(await rows(resumed)).toEqual(await rows(whole));
	});

	it("leaves an unended last line for the pass after it ends", async () => {
		const lines = richLog();
		const split = 12;
		const resumed = place("resumed");
		const whole = place("whole");
		const line = lines[split] ?? "";
		const half = Math.floor(line.length / 2);
		for (const where of [resumed, whole]) {
			writeFileSync(
				where.log,
				`${body(lines.slice(0, split))}${line.slice(0, half)}`,
			);
			await pass(where);
		}
		const before = await rows(resumed);
		for (const where of [resumed, whole]) {
			appendFileSync(
				where.log,
				`${line.slice(half)}\n${body(lines.slice(split + 1))}`,
			);
		}
		forget(whole);

		const outcome = await pass(resumed);
		await pass(whole);

		expect(JSON.stringify(before)).not.toContain('"c1"');
		expect(outcome.resumed).toBe(1);
		expect(await rows(resumed)).toEqual(await rows(whole));
	});
});

describe("a pass that cannot trust what it carried", () => {
	async function refusedAfter(
		change: (where: Place, lines: readonly string[]) => void,
	): Promise<{ refused: readonly string[]; same: boolean }> {
		const lines = richLog();
		const split = 14;
		const resumed = place("resumed");
		const whole = place("whole");
		for (const where of [resumed, whole]) {
			writeFileSync(where.log, body(lines.slice(0, split)));
			await pass(where);
			change(where, lines);
		}
		forget(whole);
		const outcome = await pass(resumed);
		await pass(whole);
		return {
			refused: outcome.refused,
			same:
				JSON.stringify(await rows(resumed)) ===
				JSON.stringify(await rows(whole)),
		};
	}

	it("reads a truncated log whole", async () => {
		const outcome = await refusedAfter((where, lines) => {
			truncateSync(where.log, 10);
			appendFileSync(where.log, body(lines.slice(20)));
		});

		expect(outcome.refused).toEqual([
			expect.stringMatching(/one\.jsonl: .*shorter/),
		]);
		expect(outcome.same, "the same rows as a whole read").toBe(true);
	});

	it("reads a log rewritten at the same length whole", async () => {
		const outcome = await refusedAfter((where, lines) => {
			const text = readFileSync(where.log, "utf8");
			writeFileSync(where.log, text.replaceAll("turn a", "turn b"));
			appendFileSync(where.log, body(lines.slice(14)));
		});

		expect(outcome.refused).toEqual([
			expect.stringMatching(/one\.jsonl: .*changed/),
		]);
		expect(outcome.same, "the same rows as a whole read").toBe(true);
	});

	it("reads a log another file replaced whole", async () => {
		const outcome = await refusedAfter((where, lines) => {
			const text = readFileSync(where.log, "utf8");
			writeFileSync(`${where.log}.new`, `${text}${body(lines.slice(14))}`);
			renameSync(`${where.log}.new`, where.log);
		});

		expect(outcome.refused).toEqual([
			expect.stringMatching(/one\.jsonl: .*another file/),
		]);
		expect(outcome.same, "the same rows as a whole read").toBe(true);
	});

	it("reads a log whole when what it carried is of an older kind", async () => {
		const outcome = await refusedAfter((where, lines) => {
			const dir = carried(where);
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (!name.endsWith(".json")) continue;
				const kept = JSON.parse(readFileSync(path, "utf8"));
				writeFileSync(path, JSON.stringify({ ...kept, version: 0 }));
			}
			appendFileSync(where.log, body(lines.slice(14)));
		});

		expect(outcome.refused).toEqual([
			expect.stringMatching(/one\.jsonl: .*older/),
		]);
		expect(outcome.same, "the same rows as a whole read").toBe(true);
	});

	it("says nothing of a log it had never carried", async () => {
		const lines = richLog();
		const where = place("fresh");
		writeFileSync(where.log, body(lines));

		const outcome = await pass(where);

		expect(outcome.resumed).toBe(0);
		expect(outcome.refused).toEqual([]);
		expect(existsSync(carried(where)), "it carries the log from now").toBe(
			true,
		);
	});
});
