/**
 * What a conversation's extensions are told at its start, from the open
 * or adopt that made it, and the folder one taken up again works in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hintsFor,
	movedWords,
	standingFolder,
} from "../../../host/engine/requests.ts";

const QUEST = "QEST-20261112-ABCDEF";
const open = {
	v: 1,
	id: "o",
	op: "open",
	cwd: "/repo",
	attended: true,
} as const;

describe("a conversation's launch hints", () => {
	it("say its quest and first words, as plain pi's environment would", () => {
		expect(hintsFor({ ...open, quest: QUEST, first: "carry on" })).toEqual({
			questId: QUEST,
			firstWords: "carry on",
		});
	});

	it("say it orchestrates when the open asks, as the launcher's Orchestrate does", () => {
		expect(hintsFor({ ...open, quest: QUEST, orchestrate: true })).toEqual({
			questId: QUEST,
			orchestrate: true,
		});
	});

	it("say nothing of orchestrating otherwise, nor of words it wasn't told", () => {
		expect(hintsFor({ ...open, quest: QUEST })).toEqual({ questId: QUEST });
		expect(hintsFor(undefined)).toEqual({});
	});
});

describe("the folder a conversation taken up again works in", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "standing-folder-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is its own while that stands, naming nothing gone", () => {
		expect(standingFolder(dir, "/home/me")).toEqual({ cwd: dir });
	});

	it("is the nearest folder above its own once its own and others under it went", () => {
		const gone = join(dir, "tree", "deep");
		expect(standingFolder(gone, "/home/me")).toEqual({ cwd: dir, gone });
	});

	it("passes over a file left where a folder was", () => {
		const tree = join(dir, "tree");
		mkdirSync(tree);
		writeFileSync(join(tree, "was-a-folder"), "");
		const gone = join(tree, "was-a-folder");
		expect(standingFolder(gone, "/home/me")).toEqual({ cwd: tree, gone });
	});

	it("is home when only the root stands above it", () => {
		const gone = "/no-such-top-folder-of-a-test/tree";
		expect(standingFolder(gone, "/home/me")).toEqual({
			cwd: "/home/me",
			gone,
		});
	});

	it("is told in words naming both folders", () => {
		const words = movedWords("/old/tree", "/old");
		expect(words).toContain("/old/tree");
		expect(words).toContain("now works in /old.");
	});
});
