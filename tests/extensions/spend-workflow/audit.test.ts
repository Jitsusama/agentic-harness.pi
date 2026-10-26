/**
 * The weekly audit: the always-on context read from session logs, and
 * the digest built from it and the ledger.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAudit, weeks } from "../../../extensions/spend-workflow/audit.ts";
import {
	byRepo,
	standingOf,
} from "../../../extensions/spend-workflow/standing.ts";

function log(lines: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "audit-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
	return path;
}

const SYSTEM = {
	type: "message",
	message: {
		role: "system",
		sections: {
			tools: "- read",
			rules: "r".repeat(30),
			project_context: "p".repeat(400),
		},
		toolsAdded: [{ name: "read" }, { name: "bash" }],
	},
};

describe("the always-on context of a session", () => {
	it("reads each piece from the log's first system message", async () => {
		const path = log([
			{ type: "session", id: "S1", cwd: "/home/me/src/walgit-rs" },
			SYSTEM,
		]);

		const prompt = await standingOf(path);

		expect(prompt).toEqual({
			session: "S1",
			repo: "/home/me/src/walgit-rs",
			tools: 2,
			pieces: {
				declarations: JSON.stringify(SYSTEM.message.toolsAdded).length,
				tools: 6,
				rules: 30,
				project_context: 400,
			},
		});
	});

	it("names the repository where the path names one", async () => {
		const path = log([
			{ type: "session", id: "S1", cwd: "/home/me/src/github.com/o/r" },
			SYSTEM,
		]);

		expect((await standingOf(path))?.repo).toBe("github.com/o/r");
	});

	it("has nothing for a log with no system message", async () => {
		const path = log([{ type: "session", id: "S1", cwd: "/x" }]);

		expect(await standingOf(path)).toBeUndefined();
	});

	it("groups sessions by repository, heaviest first, by the median session", () => {
		const grouped = byRepo([
			{ session: "a", repo: "small", tools: 1, pieces: { tools: 10 } },
			{ session: "b", repo: "big", tools: 1, pieces: { tools: 10, x: 900 } },
			{ session: "c", repo: "big", tools: 1, pieces: { tools: 10, x: 100 } },
			{ session: "d", repo: "big", tools: 1, pieces: { tools: 10, x: 500 } },
		]);

		expect(grouped.map((g) => [g.repo, g.sessions, g.total])).toEqual([
			["big", 3, 510],
			["small", 1, 10],
		]);
		expect(grouped[0]?.pieces[0]).toEqual(["x", 500]);
	});
});

describe("the audit digest", () => {
	const week = weeks(Date.parse("2026-10-22T12:00:00Z")).current;

	it("holds the week's spend against the week before", () => {
		const text = formatAudit(
			{
				week,
				spend: {
					now: { turns: 3, cost: 1500, reads: 1000, writes: 300, output: 200 },
					before: { cost: 1000 },
				},
				rewrites: [{ cause: "after compaction", times: 2, cost: 40 }],
				reads: [],
				errors: [{ name: "edit", calls: 100, failed: 3 }],
				standing: [],
				unread: 0,
			},
			12,
		);

		expect(text).toContain("Audit of 2026-10-15 to 2026-10-22.");
		expect(text).toContain("$1,500 over 3 turns, up 50% on the week before");
		expect(text).toContain("- after compaction: 2 times, $40");
		expect(text).toContain("- edit: 3 of 100 (3%)");
	});

	it("says how hidden tools were found and used, and which are worth declaring", () => {
		const text = formatAudit(
			{
				week,
				spend: { now: {}, before: {} },
				rewrites: [],
				reads: [],
				errors: [],
				standing: [],
				unread: 0,
				loading: {
					sessions: 40,
					searches: { calls: 9, sessions: 6, empty: 2 },
					hidden: [
						{ name: "browser_go", calls: 30, sessions: 12 },
						{ name: "cost", calls: 3, sessions: 2 },
					],
				},
			},
			12,
		);

		expect(text).toContain(
			"- tool_search: 9 calls in 6 sessions; 2 found nothing.",
		);
		expect(text).toContain(
			"- Used: browser_go in 12 of 40 (30 calls); cost in 2 of 40 (3 calls).",
		);
		expect(text).toContain("cheaper declared on every turn: browser_go.");
	});

	it("prices a repository's always-on context at what its reads cost", () => {
		const text = formatAudit(
			{
				week,
				spend: { now: {}, before: {} },
				rewrites: [],
				// 1,000 turns at $1 a million tokens read.
				reads: [{ repo: "big", turns: 1000, cost: 1, tokens: 1_000_000 }],
				errors: [],
				standing: [
					{
						repo: "big",
						sessions: 2,
						total: 280_000,
						pieces: [["project_context", 200_000]],
					},
				],
				unread: 1,
			},
			12,
		);

		// 280,000 characters at 2.8 a token is 100,000 tokens a turn.
		expect(text).toContain(
			"- big: 280k characters over 2 sessions, about $100 a week in reads. Largest: project_context 200k.",
		);
		expect(text).toContain("(1 log held no system message");
	});

	it("holds each kind of quest file read a session against the week before", () => {
		const text = formatAudit(
			{
				week,
				spend: { now: {}, before: {} },
				rewrites: [],
				reads: [],
				errors: [],
				standing: [],
				unread: 0,
				questReads: {
					now: [
						{ kind: "documents", calls: 60, sessions: 13, chars: 260_000 },
						{ kind: "READMEs", calls: 2, sessions: 2, chars: 9_000 },
					],
					// 8 times the documents in 4 times the active sessions: half a session.
					before: [
						{ kind: "documents", calls: 500, sessions: 52, chars: 2_080_000 },
					],
					active: { now: 20, before: 80 },
				},
			},
			12,
		);

		expect(text).toContain(
			"Quest files read with read, a share of the 20 sessions active:",
		);
		expect(text).toContain(
			"- documents: 260k characters, read in 13 of them, about 13k a session, down 50% on the week before.",
		);
		expect(text).toContain(
			"- READMEs: 9000 characters, read in 2 of them, about 450 a session.",
		);
	});

	it("says no quest file was read when none was", () => {
		const text = formatAudit(
			{
				week,
				spend: { now: {}, before: {} },
				rewrites: [],
				reads: [],
				errors: [],
				standing: [],
				unread: 0,
				questReads: { now: [], before: [], active: { now: 3, before: 0 } },
			},
			12,
		);

		expect(text).toContain(
			"Quest files read with read, a share of the 3 sessions active:\n- none",
		);
	});
});
