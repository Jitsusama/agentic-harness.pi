/**
 * The recall tool, wired up: it searches the session's own branch,
 * stores and cites what a page leaves out, and tells every summary the
 * harness writes that it exists.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionRecall, {
	RECALL_NOTE,
} from "../../../extensions/session-recall-workflow/index.ts";
import {
	newContributions,
	SUMMARY_CONTRIBUTIONS,
} from "../../../lib/compaction/index.ts";
import {
	paragraphRef,
	unitsOf,
} from "../../../lib/compaction/selection/units.ts";
import { sessionResultDir } from "../../../lib/core/result/index.ts";
import { PAGE_HITS } from "../../../lib/internal/logs/recall.ts";
import { ROLLOVER_RECORD } from "../../../lib/internal/session/rollover.ts";
import { resultSession } from "../../support/result-session.ts";

const ctx = resultSession();

interface Tool {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { text: string }[] }>;
}

function activate() {
	const tools: Tool[] = [];
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		registerTool: (tool: Tool) => tools.push(tool),
		on: () => {},
		events: {
			on: (channel: string, h: (data: unknown) => void) =>
				listeners.set(channel, [...(listeners.get(channel) ?? []), h]),
			emit: (channel: string, data: unknown) => {
				for (const h of listeners.get(channel) ?? []) h(data);
			},
		},
	};
	sessionRecall(pi as never);
	const [tool] = tools;
	if (!tool) throw new Error("no tool registered");
	return { tool, emit: pi.events.emit };
}

function said(id: string, text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-30T12:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function ctxWith(branch: unknown[]) {
	return {
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => ctx.sessionManager.getSessionId(),
		},
	};
}

afterEach(() => {
	rmSync(sessionResultDir(ctx), { recursive: true, force: true });
});

describe("the session recall tool", () => {
	it("answers a small search whole, with no handle", async () => {
		const { tool } = activate();
		const answer = await tool.execute(
			"t1",
			{ query: "flake" },
			undefined,
			undefined,
			ctxWith([said("a1", "the flake was the builder"), said("a2", "other")]),
		);
		expect(answer.content[0]?.text).toBe("[a1] the flake was the builder");
	});

	it("finds what the branch left on disk, and says what the read cost", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recall-"));
		const parent = join(dir, "parent.jsonl");
		const header = {
			type: "session",
			id: "p",
			timestamp: "2026-09-30T11:00:00.000Z",
			cwd: dir,
		};
		writeFileSync(
			parent,
			`${[header, said("old1", "the ancient flake")].map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		const record = {
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-09-30T12:00:00.000Z",
			customType: ROLLOVER_RECORD,
			data: {
				parentSession: parent,
				parentLeaf: "old1",
				dropped: 1,
				carried: {},
			},
		};
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const { tool } = activate();
			const answer = await tool.execute(
				"t1",
				{ query: "ancient" },
				undefined,
				undefined,
				ctxWith([record, said("a1", "something newer")]),
			);
			expect(answer.content[0]?.text).toBe("[old1] the ancient flake");
			expect(write).toHaveBeenCalledWith(
				expect.stringMatching(
					/^session-recall-workflow: conversation \S+ read [\d.]+ MiB from 1 log\(s\) on disk, 1 entries, in \d+ ms\n$/,
				),
			);
		} finally {
			write.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads the history on disk as older than the branch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recall-"));
		const parent = join(dir, "parent.jsonl");
		const twice = "the paragraph said on both sides";
		const header = {
			type: "session",
			id: "p",
			timestamp: "2026-09-30T11:00:00.000Z",
			cwd: dir,
		};
		writeFileSync(
			parent,
			`${[header, said("old1", twice)].map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		const record = {
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-09-30T12:00:00.000Z",
			customType: ROLLOVER_RECORD,
			data: { parentSession: parent, parentLeaf: "old1", carried: {} },
		};
		const ref = paragraphRef(unitsOf(said("x", twice) as never)[0]?.hash ?? "");
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const { tool } = activate();
			const answer = await tool.execute(
				"t1",
				{ entryId: ref },
				undefined,
				undefined,
				ctxWith([record, said("a1", twice), said("a2", "the newest")]),
			);
			// The newest entry saying it, with the older one before it.
			expect(answer.content[0]?.text).toBe(
				`[a1] (${ref}) ${twice}\n\nBefore it: old1. After it: a2.`,
			);
		} finally {
			write.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names in one journal line a parent it could not read", async () => {
		const gone = join(tmpdir(), "recall-gone\nsession-recall-workflow: forged");
		const record = {
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-09-30T12:00:00.000Z",
			customType: ROLLOVER_RECORD,
			data: { parentSession: gone, parentLeaf: "old1", carried: {} },
		};
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const { tool } = activate();
			await tool.execute(
				"t1",
				{ query: "flake" },
				undefined,
				undefined,
				ctxWith([record, said("a1", "the flake")]),
			);
			const lines = write.mock.calls.map(([text]) => String(text));
			expect(lines).toEqual([
				expect.stringMatching(
					/^session-recall-workflow: conversation \S+ could not read ".*recall-gone\\nsession-recall-workflow: forged" \(ENOENT\), so recall searched no history older than it\n$/,
				),
			]);
		} finally {
			write.mockRestore();
		}
	});

	it("says in the journal what it read of a parent it then refused, and what it read twice", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recall-"));
		const parent = join(dir, "parent.jsonl");
		const call = (id: string, parentId: string | null) => ({
			type: "message",
			id,
			parentId,
			timestamp: "2026-09-30T11:00:00.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "same", name: "bash", arguments: {} },
				],
			},
		});
		writeFileSync(
			parent,
			`${[
				{
					type: "session",
					id: "p",
					timestamp: "2026-09-30T11:00:00.000Z",
					cwd: dir,
				},
				call("c1", null),
				call("c2", "c1"),
			]
				.map((line) => JSON.stringify(line))
				.join("\n")}\n`,
		);
		const rolled = (leaf: string) => ({
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-09-30T12:00:00.000Z",
			customType: ROLLOVER_RECORD,
			data: { parentSession: parent, parentLeaf: leaf, carried: {} },
		});
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const { tool } = activate();
			for (const leaf of ["missing", "c2"]) {
				await tool.execute(
					"t1",
					{ query: "flake" },
					undefined,
					undefined,
					ctxWith([rolled(leaf), said("a1", "now")]),
				);
			}
			const lines = write.mock.calls.map(([text]) => String(text));
			expect(lines).toEqual([
				expect.stringMatching(
					/ read [\d.]+ MiB from 0 log\(s\) on disk, 0 entries, in \d+ ms\n$/,
				),
				expect.stringMatching(/ could not read ".*parent\.jsonl" \(it is not/),
				expect.stringMatching(
					/ from 1 log\(s\) on disk, 2 entries, 2 read a second time, in \d+ ms\n$/,
				),
			]);
		} finally {
			write.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says nothing in the journal when nothing is on disk to read", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const { tool } = activate();
			await tool.execute(
				"t1",
				{ query: "flake" },
				undefined,
				undefined,
				ctxWith([said("a1", "the flake")]),
			);
			expect(write).not.toHaveBeenCalledWith(
				expect.stringContaining("session-recall-workflow"),
			);
		} finally {
			write.mockRestore();
		}
	});

	it("cites a handle when hits are left for another page", async () => {
		const { tool } = activate();
		const branch = Array.from({ length: PAGE_HITS + 2 }, (_, i) =>
			said(`a${i}`, `widget ${i}`),
		);
		const answer = await tool.execute(
			"t1",
			{ query: "widget" },
			undefined,
			undefined,
			ctxWith(branch),
		);
		const text = answer.content[0]?.text ?? "";
		expect(text).toContain("2 more matching entries");
		expect(text).toMatch(/handle result-[0-9a-f]{16}/);
	});

	it("tells every summary the harness writes that the log can be searched", () => {
		const { emit } = activate();
		const contributions = newContributions({});
		emit(SUMMARY_CONTRIBUTIONS, contributions);
		expect(contributions.appendix).toEqual([RECALL_NOTE]);
		expect(RECALL_NOTE).toContain("session_recall");
	});
});
