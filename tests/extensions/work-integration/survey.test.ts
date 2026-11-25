/**
 * Tidy and reclaim through the work tool: what a checkout has spent,
 * said and never removed, and the trees beside it nothing holds, taken
 * back with their branches kept.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { seesEveryProcess } from "../../../extensions/work-integration/sweep.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import { GUARD_WORDS, strandedDir } from "../../../lib/core/work/stranded.ts";
import {
	cutTreeDir,
	treeRecordDir,
} from "../../../lib/internal/work-records.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import { checkout, claim, cut, scratchDir, work } from "./worked.ts";

/** A worktree beside the checkout, at a branch trunk already holds. */
async function spareTree(): Promise<string> {
	const path = join(scratchDir(), "spare");
	await git(checkout(), "worktree", "add", "-q", "-b", "spare", path);
	return path;
}

/**
 * A tree where the broker cuts them whose git folder is gone, as one
 * cut from a clone since deleted is, its `.git` written `ageMs` ago.
 */
function strandedTree(name: string, ageMs: number): string {
	const path = join(cutTreeDir(), name);
	mkdirSync(path, { recursive: true });
	const gone = join(scratchDir(), "deleted-clone", ".git", "worktrees", name);
	writeFileSync(join(path, ".git"), `gitdir: ${gone}\n`);
	writeFileSync(join(path, "notes.md"), "written by a reader\n");
	const at = (Date.now() - ageMs) / 1000;
	utimesSync(join(path, ".git"), at, at);
	return path;
}

/** An hour, well past the grace a cut in progress is given. */
const AN_HOUR = 60 * 60 * 1000;

/**
 * Whether this machine can say what works in a folder. Where it can't,
 * every stranded tree is rightly kept, so the cases that free one only
 * run where the kernel names every process's folders.
 */
const machineCanSay = (await seesEveryProcess()) && existsSync("/proc/1");

let elsewhere = "";
afterEach(() => {
	if (elsewhere !== "") disposeRepo(elsewhere);
	elsewhere = "";
});

describe("tidy", () => {
	it("says nothing has been spent when nothing has", async () => {
		const named = displayPath(checkout());
		const answer = await work({ action: "tidy", tree: checkout() });
		expect(answer.text).toContain(
			`${GLYPH.clean} Nothing in ${named} has been spent yet, against main.`,
		);
		expect(answer.text).toContain("Nothing has been removed.");
		expect(answer.details).toEqual({
			ok: true,
			removable: 0,
			reclaimable: 0,
			stranded: 0,
		});
	});

	it.runIf(machineCanSay)(
		"names a tree the guard won't run git in, in words of its own",
		async () => {
			// Cut for real from a repository outside every home the fence
			// keeps, which the guard refuses wherever the broker cuts trees.
			elsewhere = await freshRepo("survey-elsewhere");
			const path = join(cutTreeDir(), "snapshot-refused");
			await git(elsewhere, "worktree", "add", "-q", "--detach", path);
			const at = (Date.now() - AN_HOUR) / 1000;
			utimesSync(join(path, ".git"), at, at);

			const answer = await work({ action: "tidy", tree: checkout() });

			expect(answer.text).toContain(
				`${displayPath(path)}, a tree nothing holds that git won't read: ${GUARD_WORDS}`,
			);
			expect(answer.text, "the guard's own words aren't said").not.toContain(
				"read-only",
			);
			expect(answer.details).toMatchObject({ stranded: 1 });
		},
	);

	it.runIf(machineCanSay)(
		"names a tree git won't read apart from the checkout's, and leaves it",
		async () => {
			const path = strandedTree("snapshot-stranded", AN_HOUR);
			const named = displayPath(checkout());
			const answer = await work({ action: "tidy", tree: checkout() });
			expect(answer.text).toContain(
				`${GLYPH.clean} Nothing in ${named} has been spent yet, against main.`,
			);
			expect(answer.text).toContain(
				`${GLYPH.named} 1 tree git won't read can be set aside where the broker cuts them.`,
			);
			expect(answer.text).toContain(
				`${displayPath(path)}, a tree nothing holds that git won't read: the git folder`,
			);
			expect(answer.details).toMatchObject({ reclaimable: 0, stranded: 1 });
			expect(existsSync(path), "tidy moves nothing").toBe(true);
		},
	);

	it("names a merged branch that can go, and leaves it", async () => {
		await git(checkout(), "branch", "done");
		const named = displayPath(checkout());
		const answer = await work({ action: "tidy", tree: checkout() });
		expect(answer.text).toContain(
			`${GLYPH.named} 1 thing in ${named} can go, against main.`,
		);
		expect(answer.text).toContain(`   ${GLYPH.named} done`);
		expect(answer.details).toMatchObject({ removable: 1 });
		expect(await git(checkout(), "branch", "--list", "done")).toContain("done");
	});

	it("names a tree nothing holds, and sends the reader to reclaim", async () => {
		const spare = await spareTree();
		const answer = await work({ action: "tidy", tree: checkout() });
		expect(answer.text).toContain(
			`${displayPath(spare)}, a tree nothing holds (spare)`,
		);
		expect(answer.text).toContain("work reclaim takes them");
		expect(answer.details).toMatchObject({ reclaimable: 1 });
		expect(existsSync(spare), "tidy removes nothing").toBe(true);
	});
});

describe("reclaim", () => {
	it("says no tree is going spare when none is", async () => {
		const named = displayPath(checkout());
		const answer = await work({ action: "reclaim", tree: checkout() });
		expect(answer.text).toBe(
			`${GLYPH.clean} No tree beside ${named} is going spare, against main.`,
		);
		expect(answer.details).toEqual({ ok: true, reclaimed: 0, setAside: 0 });
	});

	it.runIf(machineCanSay)(
		"sets a tree git won't read aside whole, and tidy then counts it",
		async () => {
			const path = strandedTree("snapshot-stranded", AN_HOUR);
			const answer = await work({ action: "reclaim", tree: checkout() });
			expect(answer.text).toContain(
				`${GLYPH.named} Set aside 1 tree git won't read where the broker cuts them.`,
			);
			expect(answer.text, "none is counted as the checkout's").not.toContain(
				"Took back",
			);
			expect(answer.details).toEqual({ ok: true, reclaimed: 0, setAside: 1 });
			expect(existsSync(path), "its name is free to cut again").toBe(false);
			const into = strandedDir(cutTreeDir());
			const [aside] = readdirSync(into);
			expect(aside).toMatch(/^snapshot-stranded-[0-9a-f]{8}$/);
			expect(
				readFileSync(join(into, aside ?? "", "notes.md"), "utf8"),
				"every file it held goes with it",
			).toBe("written by a reader\n");

			const tidy = await work({ action: "tidy", tree: checkout() });
			expect(tidy.text).toContain(
				`1 tree set aside earlier wait in ${displayPath(into)}.`,
			);
		},
	);

	it("keeps a tree git won't read that a quest claims, naming it nowhere", async () => {
		// A claim outranks everything, so the tree is never offered: not
		// even as kept, which is how a machine that can't say lists it.
		const path = strandedTree("snapshot-claimed", AN_HOUR);
		claim(path);

		const tidy = await work({ action: "tidy", tree: checkout() });
		const reclaim = await work({ action: "reclaim", tree: checkout() });

		expect(tidy.text).not.toContain(displayPath(path));
		expect(tidy.details).toMatchObject({ stranded: 0 });
		expect(reclaim.details).toEqual({ ok: true, reclaimed: 0, setAside: 0 });
		expect(existsSync(path), "it stays where it was").toBe(true);
	});

	it("keeps a tree git won't read that a running session's record names", async () => {
		// This session's own owner, taken from a tree it really cut.
		await cut("topic");
		const memory = createTreeMemory(treeRecordDir());
		const [ours] = memory.recall();
		const path = strandedTree("snapshot-recorded", AN_HOUR);
		memory.remember({
			identity: { key: "snapshot-recorded", shareable: true },
			path,
			providerId: "git",
			...(ours?.owners === undefined ? {} : { owners: ours.owners }),
		});

		const reclaim = await work({ action: "reclaim", tree: checkout() });

		expect(ours?.owners, "the cut recorded its owner").toBeDefined();
		expect(reclaim.text).not.toContain(displayPath(path));
		expect(reclaim.details).toMatchObject({ setAside: 0 });
		expect(existsSync(path), "it stays where it was").toBe(true);
	});

	it("keeps a tree git won't read that may still be being cut", async () => {
		const path = strandedTree("snapshot-cutting", 0);
		const answer = await work({ action: "reclaim", tree: checkout() });
		expect(answer.text).toContain(
			`${displayPath(path)}: git won't read it, but it was cut in the last ten minutes`,
		);
		expect(answer.details).toEqual({ ok: true, reclaimed: 0, setAside: 0 });
		expect(existsSync(path), "it stays where it was").toBe(true);
	});

	it.runIf(machineCanSay)(
		"keeps a tree the checkout's own entry names, asked from it or a tree it holds, and keeps that entry's lock",
		async () => {
			// Once the clone has moved, the tree's `.git` names a folder that
			// is gone, and only the clone's own entry still names it. Git
			// lists the tree for that entry, locked or not, which is what
			// keeps it: reclaim leaves every tree git lists to git, and the
			// lock a later cut must meet is left as it was.
			const path = strandedTree("snapshot-locked", AN_HOUR);
			const entry = join(checkout(), ".git", "worktrees", "snapshot-locked");
			mkdirSync(entry, { recursive: true });
			writeFileSync(join(entry, "gitdir"), `${join(path, ".git")}\n`);
			writeFileSync(join(entry, "locked"), "on a drive away\n");

			const fromCheckout = await work({ action: "reclaim", tree: checkout() });
			await cut("topic");
			const fromHeld = await work({ action: "reclaim" });

			expect(fromCheckout.details).toMatchObject({ setAside: 0 });
			expect(fromHeld.details, "from the one tree held").toMatchObject({
				setAside: 0,
			});
			expect(existsSync(path), "it stays where it was").toBe(true);
			expect(existsSync(join(entry, "locked")), "its lock stays").toBe(true);
		},
	);

	it("takes back a tree nothing holds and keeps its branch", async () => {
		const spare = await spareTree();
		const named = displayPath(checkout());
		const answer = await work({ action: "reclaim", tree: checkout() });
		expect(answer.text).toContain(
			`${GLYPH.named} Took back 1 tree beside ${named}.`,
		);
		expect(answer.text).toContain(
			`   ${GLYPH.named} ${displayPath(spare)}, spare kept`,
		);
		expect(answer.text).toContain("Every branch kept is still where it was.");
		expect(answer.details).toEqual({ ok: true, reclaimed: 1, setAside: 0 });
		expect(existsSync(spare), "the tree is gone").toBe(false);
		expect(await git(checkout(), "branch", "--list", "spare")).toContain(
			"spare",
		);
	});

	it("refuses a tree that is neither held nor in a checkout", async () => {
		const answer = await work({ action: "reclaim", tree: "/nowhere/at/all" });
		expect(answer.text).toMatch(
			new RegExp(`^${GLYPH.refused} No held tree called /nowhere/at/all`),
		);
	});
});
