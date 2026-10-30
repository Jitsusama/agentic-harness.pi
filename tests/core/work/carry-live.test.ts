/**
 * Carrying a tree's work home, through real git.
 *
 * What matters is that the commits come back out the other end, so the
 * test makes the bundle, then fetches it into a second clone of the same
 * remote, the way a tree at home takes it up. A fake exec would answer
 * whatever it was told and prove nothing about the bundle.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carrySession, carryTree } from "../../../lib/core/work/carry.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

/** An exec over real processes, shaped the way the library expects. */
const exec = (command: string, args: readonly string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code:
					error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			}),
		),
	);

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) disposeRepo(dir);
	dirs = [];
});

/** A folder of its own, removed after the test. */
function folder(name: string): string {
	const made = mkdtempSync(join(tmpdir(), `carry-${name}-`));
	dirs.push(made);
	return made;
}

/** Two clones of one remote: the leaving machine's tree, and home's. */
async function twoClones(): Promise<{ leaving: string; home: string }> {
	const remote = await freshRepo("carry-remote");
	const leaving = await freshRepo("carry-leaving");
	const home = await freshRepo("carry-home");
	dirs.push(remote, leaving, home);
	await git(remote, "config", "receive.denyCurrentBranch", "ignore");
	for (const clone of [leaving, home]) {
		await git(clone, "remote", "add", "origin", remote);
		await git(clone, "fetch", "-q", "origin");
		await git(clone, "reset", "-q", "--hard", "origin/main");
	}
	return { leaving, home };
}

describe("carrying a tree's work home", () => {
	it("bundles the commits no remote has, which a tree at home fetches", async () => {
		const { leaving, home } = await twoClones();
		await git(leaving, "checkout", "-q", "-b", "topic");
		for (const n of [1, 2]) {
			writeFileSync(join(leaving, `work-${n}.txt`), `${n}\n`);
			await git(leaving, "add", ".");
			await git(leaving, "commit", "-q", "-m", `work ${n}`);
		}
		const head = await git(leaving, "rev-parse", "HEAD");
		const base = await git(leaving, "rev-parse", "origin/main");
		const into = folder("handover");

		const outcome = await carryTree(exec, leaving, into, "topic-tree");

		expect(outcome, "the two commits are carried").toMatchObject({
			kind: "carried",
			carried: { branch: "topic", head, commits: 2, left: [] },
		});
		expect(
			outcome.kind === "carried" ? outcome.carried.needs : [],
			"it says what home must hold first, and where that was",
		).toEqual([{ commit: base, on: "origin/main" }]);
		const note = JSON.parse(
			readFileSync(join(into, "topic-tree.json"), "utf8"),
		);
		expect(note.bundle, "the note names the bundle beside it").toBe(
			"topic-tree.bundle",
		);
		await git(home, "fetch", "-q", join(into, note.bundle), "topic:topic");
		expect(
			await git(home, "rev-parse", "topic"),
			"home has the branch as it was left",
		).toBe(head);
	});

	it("carries nothing when every commit is on a remote", async () => {
		const { leaving } = await twoClones();
		const into = folder("handover");

		const outcome = await carryTree(exec, leaving, into, "main-tree");

		expect(outcome, "nothing needs carrying").toEqual({
			kind: "nothing",
			branch: "main",
			left: [],
		});
		expect(
			existsSync(join(into, "main-tree.bundle")),
			"and no bundle is written",
		).toBe(false);
	});

	it("carries the commits of a tree with files not committed, naming what stays", async () => {
		const { leaving } = await twoClones();
		writeFileSync(join(leaving, "kept.txt"), "kept\n");
		await git(leaving, "add", "kept.txt");
		await git(leaving, "commit", "-q", "-m", "unpushed");
		await git(leaving, "mv", "kept.txt", "moved.txt");
		writeFileSync(join(leaving, "draft one.txt"), "not yet\n");
		const into = folder("handover");

		const outcome = await carryTree(exec, leaving, into, "main-tree");

		expect(outcome, "stray files don't keep the commit behind").toMatchObject({
			kind: "carried",
			carried: { commits: 1 },
		});
		expect(
			JSON.parse(readFileSync(join(into, "main-tree.json"), "utf8")).left,
			"and the note names the files that stayed as they are on disk",
		).toEqual(["moved.txt", "draft one.txt"]);
	});
});

describe("carrying a session home", () => {
	it("copies its file beside what Restore needs to reopen it", () => {
		const from = folder("sessions");
		const file = join(from, "2026-10-30_abc.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const into = folder("handover");

		const note = carrySession(file, into, {
			id: "abc",
			cwd: "/home/aquifer/trees/topic",
			quest: "QEST-20261030-ABCDEF",
		});

		expect(
			readFileSync(join(into, "2026-10-30_abc.jsonl"), "utf8"),
			"the file is copied whole",
		).toBe('{"type":"session"}\n');
		expect(
			JSON.parse(readFileSync(note, "utf8")),
			"the note says which session, where it ran and its file",
		).toEqual({
			id: "abc",
			cwd: "/home/aquifer/trees/topic",
			quest: "QEST-20261030-ABCDEF",
			file: "2026-10-30_abc.jsonl",
		});
		rmSync(file);
	});
});
