/**
 * The recall tool, wired up: it searches the session's own branch,
 * stores and cites what a page leaves out, and tells every summary the
 * harness writes that it exists.
 */

import { rmSync } from "node:fs";
import { sessionResultDir } from "@jitsusama/agentic-harness.core/result";
import { afterEach, describe, expect, it } from "vitest";
import sessionRecall, {
	RECALL_NOTE,
} from "../../../extensions/session-recall-workflow/index.ts";
import {
	newContributions,
	SUMMARY_CONTRIBUTIONS,
} from "../../../lib/compaction/index.ts";
import { PAGE_HITS } from "../../../lib/internal/recall/session.ts";

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
	return { sessionManager: { getBranch: () => branch } };
}

afterEach(() => {
	rmSync(sessionResultDir(), { recursive: true, force: true });
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
