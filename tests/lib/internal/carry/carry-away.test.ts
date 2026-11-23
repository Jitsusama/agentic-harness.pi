/**
 * Carrying a session's work away into its quest's handover, through real
 * git: its trees as bundles and patches, its file, and the done file.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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

	it("passes over a snapshot on no branch, to be cut again there", async () => {
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
				why: expect.stringContaining("on no branch"),
			},
		]);
	});

	// Records of trees removed by hand were refused, 16 of 18 at once.
	it("passes over a tree gone from this machine", async () => {
		const { origin, home, into } = await homeWithTree();
		const gone = await cloneAt(origin, join(home, "src", "gone"));
		rmSync(gone, { recursive: true, force: true });

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-gone", cwd: home },
			trees: [gone],
		});

		expect(carried.trees).toEqual([
			{
				kind: "skipped",
				path: gone,
				why: expect.stringContaining("gone from this machine"),
			},
		]);
	});

	// The share refuses a file over its limit only after the session closed.
	it("refuses a tree whose bundle the share would refuse, leaving none of it to send", async () => {
		const { home, tree, into } = await homeWithTree();
		await git(tree, "checkout", "-q", "-b", "topic");
		await commit(tree, "work.txt", "unpushed\n".repeat(400));
		writeFileSync(join(tree, "README.md"), "changed\n");

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-big", cwd: home },
			trees: [tree],
			largestFile: 200,
		});

		expect(carried.trees).toEqual([
			{
				kind: "refused",
				path: tree,
				why: expect.stringMatching(
					/^Its .*\.bundle is \d+ bytes, over the 200 bytes the share carries\.$/,
				),
			},
		]);
		expect(carried.handover.trees).toEqual([]);
		expect(
			readdirSync(into).filter((name) => /\.(bundle|patch)$/.test(name)),
			"neither its bundle nor its patch is left for the share",
		).toEqual([]);
	});

	// A folder git can't read as a tree is refused, not passed over as
	// one on no branch.
	it("refuses a folder git can't read as a tree, rather than passing it over", async () => {
		const { home, into } = await homeWithTree();
		const plain = folder(made, "plain");

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-plain", cwd: home },
			trees: [plain],
		});

		expect(carried.trees).toEqual([
			{
				kind: "refused",
				path: plain,
				why: expect.stringContaining("git couldn't read it as a tree"),
			},
		]);
	});

	// git -C walks up, so a folder in a tree would be carried as that tree.
	it("refuses a folder inside another tree, rather than carrying that tree", async () => {
		const { home, tree, into } = await homeWithTree();
		const inside = join(tree, "zone");
		mkdirSync(inside);

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-inside", cwd: home },
			trees: [inside],
		});

		expect(carried.trees).toEqual([
			{
				kind: "refused",
				path: inside,
				why: expect.stringContaining("inside another tree"),
			},
		]);
		expect(carried.handover.trees).toEqual([]);
	});

	// Carried as whole, a sparse World tree would check out all of World.
	it("refuses a sparse tree whose patterns can't be carried, rather than carrying it whole", async () => {
		const { home, tree, into } = await homeWithTree();
		await git(tree, "config", "core.sparseCheckout", "true");
		await git(tree, "config", "core.sparseCheckoutCone", "false");
		writeFileSync(join(tree, ".git", "info", "sparse-checkout"), "-odd\n");

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-sparse", cwd: home },
			trees: [tree],
		});

		expect(carried.trees).toEqual([
			{
				kind: "refused",
				path: tree,
				why: expect.stringContaining("can't be carried"),
			},
		]);
		expect(carried.handover.trees).toEqual([]);
	});

	// Only a path that isn't there is gone; one that can't be told is kept.
	it("refuses a tree whose folder can't be looked into, rather than calling it gone", async () => {
		const { origin, home, into } = await homeWithTree();
		const shut = join(home, "shut");
		const tree = await cloneAt(origin, join(shut, "app"));
		chmodSync(shut, 0o000);
		try {
			const carried = await carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-shut", cwd: home },
				trees: [tree],
			});

			expect(carried.trees).toEqual([
				{
					kind: "refused",
					path: tree,
					why: expect.stringContaining("can't be read here"),
				},
			]);
		} finally {
			chmodSync(shut, 0o755);
		}
	});

	// Refusing these closed live sessions on 23 November: what was
	// committed or changed in it stays here, where it was.
	it("passes over a tree on no branch with work in it, and still carries the rest", async () => {
		const { origin, home, tree, into } = await homeWithTree();
		await git(tree, "checkout", "-q", "--detach");
		const kept = await commit(tree, "lost.txt", "would be lost\n");
		writeFileSync(join(tree, "draft.txt"), "never added\n");
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
			"skipped",
			"carried",
		]);
		expect(
			await git(tree, "rev-parse", "HEAD"),
			"its commit stays here, checked out",
		).toBe(kept);
		expect(
			readFileSync(join(tree, "draft.txt"), "utf8"),
			"and so does what it never added",
		).toBe("never added\n");
		expect(carried.handover.trees.map((one) => one.path)).toEqual([
			"~/src/other",
		]);
	});

	it("gzips a session file larger than the share takes, and carries one at the limit as it is", async () => {
		const { home, into } = await homeWithTree();
		const log = `{"type":"session","id":"s-5"}\n${'{"type":"message"}\n'.repeat(500)}`;
		const big = join(folder(made, "sessions"), "2026-11-07_s-5.jsonl");
		writeFileSync(big, log);
		const small = join(folder(made, "sessions"), "2026-11-07_s-6.jsonl");
		writeFileSync(small, log);

		const zipped = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-5", cwd: home, file: big },
			trees: [],
			largestFile: 1000,
		});
		const plain = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-6", cwd: home, file: small },
			trees: [],
			largestFile: log.length,
		});

		expect(zipped.handover.sessionFile).toBe("2026-11-07_s-5.jsonl.gz");
		expect(
			gunzipSync(
				readFileSync(join(into, "2026-11-07_s-5.jsonl.gz")),
			).toString(),
			"it unzips to the same bytes",
		).toBe(log);
		expect(
			readHandover(join(into, "s-5.done.json"))?.sessionFile,
			"the done file names the zipped file and reads back",
		).toBe("2026-11-07_s-5.jsonl.gz");
		expect(
			existsSync(join(into, "2026-11-07_s-5.jsonl")),
			"no plain copy beside it",
		).toBe(false);
		expect(plain.handover.sessionFile).toBe("2026-11-07_s-6.jsonl");
		expect(readFileSync(join(into, "2026-11-07_s-6.jsonl"), "utf8")).toBe(log);
		expect(
			readdirSync(join(into, "..", "..", "tmp")),
			"nothing is left where it was gzipped",
		).toEqual([]);
	});

	it("refuses a session file still too large once gzipped, leaving nothing for the share", async () => {
		const { home, tree, into } = await homeWithTree();
		await git(tree, "checkout", "-q", "-b", "topic");
		await commit(tree, "work.txt", "unpushed\n");
		const file = join(folder(made, "sessions"), "2026-11-07_s-7.jsonl");
		writeFileSync(file, '{"type":"message"}\n'.repeat(500));

		await expect(
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-7", cwd: tree, file },
				trees: [tree],
				largestFile: 50,
			}),
		).rejects.toThrow(/gzipped, still over the 0\.0 MiB the share carries/);
		expect(readdirSync(into), "no bundle, file or done file").toEqual([]);
		expect(readdirSync(join(into, "..", "..", "tmp"))).toEqual([]);
	});
});
