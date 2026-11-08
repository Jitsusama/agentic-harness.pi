/**
 * Carrying a session's work away into its quest's handover, through real
 * git: its trees as bundles and patches, its file, and the done file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carryAway } from "../../../../lib/internal/carry/carry-away.ts";
import { readHandover } from "../../../../lib/internal/carry/handover.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const QUEST = "QEST-20261107-CARRY1";

/** A home with a clone of a fresh origin at `~/src/app`. */
async function homeWithTree() {
	const origin = await bareOrigin(made);
	const home = folder(made, "home");
	const tree = await cloneAt(origin, join(home, "src", "app"));
	const into = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
	return { origin, home, tree, into };
}

describe("carrying a session's work away", () => {
	it("carries its tree's commits and changes and its file, then says so in its done file", async () => {
		const { origin, home, tree, into } = await homeWithTree();
		const base = await git(tree, "rev-parse", "HEAD");
		await git(tree, "checkout", "-q", "-b", "topic");
		const head = await commit(tree, "work.txt", "unpushed\n");
		writeFileSync(join(tree, "README.md"), "changed, never committed\n");
		writeFileSync(join(tree, "draft.txt"), "never added\n");
		await commit(tree, "staged.txt", "x\n").then(() =>
			git(tree, "reset", "-q", "--soft", "HEAD~1"),
		);
		const statusBefore = await git(tree, "status", "--porcelain");
		const sessionFile = join(folder(made, "sessions"), "2026-11-07_s-1.jsonl");
		writeFileSync(sessionFile, '{"type":"session","id":"s-1"}\n');

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-1", cwd: tree, title: "Carry it", file: sessionFile },
			trees: [tree],
		});

		const done = readHandover(join(into, "s-1.done.json"));
		expect(done, "the done file reads back whole").toEqual(carried.handover);
		expect(done).toMatchObject({
			session: "s-1",
			quest: QUEST,
			cwd: "~/src/app",
			title: "Carry it",
			sessionFile: "2026-11-07_s-1.jsonl",
			trees: [
				{
					path: "~/src/app",
					origin,
					branch: "topic",
					head,
					needs: [{ commit: base, on: "origin/main" }],
				},
			],
		});
		const handed = done?.trees[0];
		expect(existsSync(join(into, handed?.bundle ?? "-")), "its bundle").toBe(
			true,
		);
		const patch = readFileSync(join(into, handed?.patch ?? "-"), "utf8");
		expect(patch, "its patch holds the change").toContain(
			"changed, never committed",
		);
		expect(patch, "the file never added").toContain("never added");
		expect(patch, "and the file staged").toContain("staged.txt");
		expect(
			readFileSync(join(into, "2026-11-07_s-1.jsonl"), "utf8"),
			"its session file is beside it",
		).toContain('"id":"s-1"');
		expect(
			await git(tree, "status", "--porcelain"),
			"and the tree's own index and files are as they were",
		).toBe(statusBefore);
	});

	it("bundles nothing for a tree a remote has whole, naming where its head is", async () => {
		const { home, tree, into } = await homeWithTree();
		const head = await git(tree, "rev-parse", "HEAD");

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-2", cwd: home },
			trees: [tree],
		});

		expect(carried.handover).toEqual({
			session: "s-2",
			quest: QUEST,
			cwd: "~",
			trees: [
				{
					path: "~/src/app",
					origin: expect.any(String),
					branch: "main",
					head,
					needs: [{ commit: head, on: "origin/main" }],
				},
			],
		});
	});

	it("passes over a snapshot of a commit a remote has, with nothing in it to carry", async () => {
		const { home, tree, into } = await homeWithTree();
		await git(tree, "checkout", "-q", "--detach");

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-3", cwd: tree },
			trees: [tree],
		});

		expect(carried.handover.trees).toEqual([]);
		expect(carried.trees).toEqual([
			{
				kind: "skipped",
				path: tree,
				why: expect.stringContaining("nothing to carry"),
			},
		]);
	});

	it("refuses a tree on no branch with work in it, and still carries the rest", async () => {
		const { origin, home, tree, into } = await homeWithTree();
		await git(tree, "checkout", "-q", "--detach");
		await commit(tree, "lost.txt", "would be lost\n");
		const other = await cloneAt(origin, join(home, "src", "other"));

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-4", cwd: tree },
			trees: [tree, other],
		});

		expect(carried.trees.map((one) => one.kind)).toEqual([
			"refused",
			"carried",
		]);
		expect(carried.handover.trees.map((one) => one.path)).toEqual([
			"~/src/other",
		]);
	});
});
