/**
 * A session whose trees can't be told is held from an ordered carry,
 * saying why, and in words even where what was thrown says nothing: a
 * carry that can't see a tree mustn't leave it behind unasked.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { orderedHolds } from "../../../extensions/mesh-workflow/ordered-carry.ts";
import { createBoard } from "../../../lib/mesh/lease.ts";

// What reading the trees a session holds throws, or the trees it reads,
// while a test sets them.
const reading = vi.hoisted(() => ({
	throws: undefined as Error | undefined,
	trees: undefined as string[] | undefined,
}));
vi.mock("../../../lib/internal/work-records.ts", async (importOriginal) => {
	const records =
		await importOriginal<
			typeof import("../../../lib/internal/work-records.ts")
		>();
	return {
		...records,
		treesHeldByNow: async (
			...args: Parameters<typeof records.treesHeldByNow>
		) => {
			if (reading.throws) throw reading.throws;
			if (reading.trees) return reading.trees;
			return records.treesHeldByNow(...args);
		},
	};
});

/** A fresh git tree with no rebase under way. */
function gitTree(): string {
	const tree = mkdtempSync(join(tmpdir(), "ordered-trees-git-"));
	execFileSync("git", ["init", "-q", tree]);
	return tree;
}

/** Said for what was thrown that said nothing, as carrying's messageOf words it. */
const SILENT = "something was thrown that said nothing of why";

const SESSION = "01a19111-trees";

/** An idle session with nothing typed, no messages waiting and no jobs. */
const ctx = {
	hasUI: false,
	isIdle: () => true,
	hasPendingMessages: () => false,
	sessionManager: { getSessionId: () => SESSION },
} as unknown as ExtensionContext;

/** What holds a session holding nothing else, as an ordered carry asks after its run. */
const holds = () =>
	orderedHolds(
		{
			ctx,
			events: undefined,
			prompts: 0,
			board: createBoard(mkdtempSync(join(tmpdir(), "ordered-trees-"))),
			session: SESSION,
		},
		true,
	);

describe("a session whose trees can't be told", () => {
	it("is held, saying why", async () => {
		reading.throws = new Error("the records folder is gone");
		try {
			expect(await holds()).toBe(
				"the trees it holds can't be told: the records folder is gone",
			);
		} finally {
			reading.throws = undefined;
		}
	});

	it("is held in words where what was thrown says nothing", async () => {
		reading.throws = Object.assign(new Error("said"), { message: "" });
		try {
			expect(await holds()).toBe(`the trees it holds can't be told: ${SILENT}`);
		} finally {
			reading.throws = undefined;
		}
	});

	it("isn't held when they can be told and none has a rebase halted", async () => {
		reading.trees = [gitTree()];
		try {
			expect(await holds()).toBeUndefined();
		} finally {
			reading.trees = undefined;
		}
	});

	it("is held, naming the tree, when one it holds has a rebase halted", async () => {
		const clean = gitTree();
		const halted = gitTree();
		mkdirSync(join(halted, ".git", "rebase-merge"));
		reading.trees = [clean, halted];
		try {
			expect(await holds()).toBe(`a rebase is halted part-way in ${halted}`);
		} finally {
			reading.trees = undefined;
		}
	});
});
