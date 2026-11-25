/**
 * What the work tool says of the trees it holds: the listing, the
 * state of the work in one, giving one back, and which tree a call
 * means.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { treeDir } from "../../../extensions/work-integration/broker.ts";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { systemFacts } from "../../../lib/core/process/process.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import { HAND_LOCKED, strandedDir } from "../../../lib/core/work/stranded.ts";
import { treeRecordDir } from "../../../lib/internal/work-records.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { git } from "../../support/git-fixture.ts";
import {
	checkout,
	cut,
	cutWhereTheToolCuts,
	REPO,
	scratchDir,
	work,
} from "./worked.ts";

describe("listing what is held", () => {
	it("says how to get a tree when none is held", async () => {
		expect(await work({})).toEqual({
			text: `${GLYPH.named} No trees held. Ask for one with action 'tree' or 'snapshot'.`,
			details: { ok: true, held: 0 },
		});
	});

	it("lists each held tree with where it is and what cut it", async () => {
		const { key, path } = await cut();
		const listed = await work({ action: "trees" });
		expect(listed.text).toContain(`${GLYPH.tree} ${key}`);
		expect(listed.text, "where it is and what cut it").toContain(
			`${displayPath(path)} · copying`,
		);
		expect(listed.details).toMatchObject({ ok: true, held: 1 });
	});
});

/**
 * The one tree record there is, dated `hours` ago as a sweep reads it,
 * answering when it was last written.
 */
function recordAged(hours: number): () => number {
	const names = readdirSync(treeRecordDir());
	expect(names, "not one tree record, so this case tests nothing").toHaveLength(
		1,
	);
	const file = join(treeRecordDir(), names[0] ?? "");
	const then = new Date(Date.now() - hours * 3_600_000);
	utimesSync(file, then, then);
	return () => statSync(file).mtimeMs;
}

// A reader sent to a tree by path leaves no sign a sweep can see, so
// whatever hands a tree's path out dates its use, as an ask does.
describe("dating the trees it names", () => {
	it("dates each tree it lists", async () => {
		await cut();
		const written = recordAged(5);
		const before = written();

		await work({ action: "trees" });

		expect(written(), "listing a tree didn't date its use").toBeGreaterThan(
			before,
		);
	});

	it("dates the tree an action names", async () => {
		const { key } = await cut();
		const written = recordAged(5);
		const before = written();

		await work({ action: "status", tree: key });

		expect(written(), "naming a tree didn't date its use").toBeGreaterThan(
			before,
		);
	});

	// The broker's listing drops a tree whose folder went, so a take
	// before the action reads as not held; the refusal in the action is
	// for a take landing between that listing and the dating.
	it("says a tree a sweep took is no longer held", async () => {
		const { key, path } = await cut();
		rmSync(path, { recursive: true, force: true });

		const status = await work({ action: "status", tree: key });

		expect(status.text).toBe(
			`${GLYPH.refused} No held tree called ${key}: none are held.`,
		);
	});
});

describe("the work in a tree", () => {
	it("says a clean tree is clean, and the branch it is on", async () => {
		const { key } = await cut();
		expect(await work({ action: "status" })).toEqual({
			text: `${GLYPH.clean} ${key} is clean, on topic.`,
			details: { ok: true, clean: true },
		});
	});

	it("lists each changed path", async () => {
		const { key, path } = await cut();
		writeFileSync(join(path, "notes.txt"), "work\n");
		const status = await work({ action: "status", tree: key });
		expect(status.text).toContain(
			`${GLYPH.dirty} ${key} has 1 changed paths, on topic.`,
		);
		expect(status.text).toContain("notes.txt");
		expect(status.details).toEqual({ ok: true, clean: false, changed: 1 });
	});
});

describe("giving a tree back", () => {
	it("releases a clean tree and stops listing it", async () => {
		const { key, path } = await cut();
		expect(await work({ action: "release", tree: key })).toEqual({
			text: `${GLYPH.named} Released ${key}.`,
			details: { ok: true, released: key },
		});
		expect(existsSync(path), "the tree is gone from disk").toBe(false);
		expect((await work({})).details).toEqual({ ok: true, held: 0 });
	});

	it("refuses to release a tree holding uncommitted work, keeping it", async () => {
		const { key, path } = await cut();
		writeFileSync(join(path, "notes.txt"), "work\n");
		const released = await work({ action: "release", tree: key });
		expect(released.text).toBe(
			`${GLYPH.refused} This tree is holding uncommitted work (notes.txt), so re-pointing it would throw that away. Commit it, stash it, or ask for a different tree.`,
		);
		expect(released.details.ok).not.toBe(true);
		expect(existsSync(join(path, "notes.txt")), "the work is kept").toBe(true);
	});

	it("sets a tree git won't run in aside whole, its work and all, and stops listing it", async () => {
		cutWhereTheToolCuts();
		const { key, path } = await unread();
		writeFileSync(join(path, "notes.txt"), "work\n");

		const released = await work({ action: "release", tree: key });

		const aside = released.details.aside;
		if (typeof aside !== "string") throw new Error(released.text);
		expect(released.text).toBe(
			`${GLYPH.named} Released ${key} by setting it aside whole at ${displayPath(aside)}: git won't run in it outside the sandbox, so what it holds couldn't be read, and every file in it was kept. Its .git, a repository of its own rather than a worktree's, or a link to one, was renamed, and whatever was committed in it is there alone, on no branch of the checkout that cut it. Run no git in it, nor in any repository inside it: a command in the sandbox may have written the settings and hooks git would run. Git's refusal: its .git is a link, which pi won't follow outside the sandbox: git would run whatever settings it leads to.`,
		);
		expect(released.details).toEqual({ ok: true, released: key, aside });
		expect(dirname(aside), "set aside where reclaim sets them").toBe(
			strandedDir(treeDir()),
		);
		expect(existsSync(path), "the tree is gone from where it was").toBe(false);
		expect(existsSync(join(aside, "notes.txt")), "its work is kept").toBe(true);
		expect(lstatSync(join(aside, ".git-was")).isSymbolicLink()).toBe(true);
		expect(existsLink(join(aside, ".git")), "parted from git").toBe(false);
		expect(existsSync(join(aside, ".git-real")), "git's own kept").toBe(true);
		expect((await work({})).details).toEqual({ ok: true, held: 0 });
	});

	it("sets a tree whose .git was taken away aside, saying nothing was renamed", async () => {
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		rmSync(join(path, ".git"), { recursive: true, force: true });

		const released = await work({ action: "release", tree: key });

		const aside = released.details.aside;
		if (typeof aside !== "string") throw new Error(released.text);
		expect(released.text).toContain(
			"It held no .git, so nothing was renamed. Git's entry for it, with its branch or a snapshot's commit, stays in the checkout that cut it until `git worktree prune` there",
		);
		expect(released.text).toContain(
			"Git's refusal: it lies where the work tool cuts trees but holds no .git, as when a command removed it",
		);
		expect(released.text, "its path is never said").not.toContain(path);
		expect(existsSync(join(aside, ".git-was")), "nothing was parted").toBe(
			false,
		);
	});

	it("keeps a .git-was the tree holds, parting its .git under a free name", async () => {
		cutWhereTheToolCuts();
		const { key, path } = await unread();
		writeFileSync(join(path, ".git-was"), "mine\n");

		const { details } = await work({ action: "release", tree: key });

		const aside = String(details.aside);
		expect(readFileSync(join(aside, ".git-was"), "utf8")).toBe("mine\n");
		const parted = readdirSync(aside).filter((name) =>
			/^\.git-was-[0-9a-f]{8}$/.test(name),
		);
		expect(parted).toHaveLength(1);
		expect(lstatSync(join(aside, parted[0] ?? "")).isSymbolicLink()).toBe(true);
	});

	it("keeps a tree git won't run in, still held, when it can't be set aside", async () => {
		cutWhereTheToolCuts();
		const { key, path } = await unread();
		// A file where the folder for set-aside trees goes stops its making.
		mkdirSync(dirname(strandedDir(treeDir())), { recursive: true });
		writeFileSync(strandedDir(treeDir()), "in the way\n");

		const released = await work({ action: "release", tree: key });

		expect(released.text).toMatch(
			new RegExp(
				`^${GLYPH.refused} Git won't run in .+, so it was to be set aside whole, but that was refused: .+\\. It is still there and still held\\. Git's refusal: its \\.git is a link, which pi won't follow outside the sandbox: git would run whatever settings it leads to\\.$`,
			),
		);
		expect(released.details.ok).not.toBe(true);
		expect(existsSync(path), "the tree is where it was").toBe(true);
		expect(heldHere(), "this session still holds it").toBe(true);
	});

	it("keeps a tree whose .git names a git folder that is gone, as repair can bring it back", async () => {
		// The checkout that cut it moved, or its volume isn't mounted, and
		// `git worktree repair` from where it is now mends the tree, which a
		// move into the stranded folder would undo.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		rmSync(join(path, ".git"), { recursive: true, force: true });
		writeFileSync(
			join(path, ".git"),
			`gitdir: ${join(dirname(path), "moved", ".git", "worktrees", "x")}\n`,
		);

		const released = await work({ action: "release", tree: key });

		expect(released.details.aside, released.text).toBeUndefined();
		expect(released.text).toMatch(
			new RegExp(
				`^${GLYPH.refused} Git won't run in .+: its \\.git names a worktree's git folder whose repository isn't there, as when the checkout that cut it moved or its volume isn't mounted\\. It is still there and still held\\. `,
			),
		);
		// The folder its .git names is a command's to choose.
		expect(released.text).not.toContain(join("moved", ".git"));
		expect(released.text).toContain(
			`Mount its volume, or run \`git worktree repair ${path}\` from the checkout you cut it from where that stands now, never from a folder its .git names, which a sandboxed command could have written; then release it again. If that checkout is gone for good, move the tree aside by hand.`,
		);
		expect(existsSync(join(path, ".git")), "the tree is where it was").toBe(
			true,
		);
		expect(heldHere(), "this session still holds it").toBe(true);
	});

	it("sets aside a tree whose entry is gone from a checkout that still stands, which no repair brings back", async () => {
		// A prune, or a hand, took the entry; repair mends only one there.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const entry = handLockable();
		rmSync(entry, { recursive: true, force: true });
		rmSync(join(path, ".git"), { recursive: true, force: true });
		writeFileSync(join(path, ".git"), `gitdir: ${entry}\n`);

		const released = await work({ action: "release", tree: key });

		expect(typeof released.details.aside, released.text).toBe("string");
		expect(released.text).toContain(
			"Its .git was renamed. Where it led wasn't read, so whatever was committed in it may be there alone",
		);
		expect(heldHere(), "no longer held").toBe(false);
	});

	it("sets aside a tree whose .git names a folder that is no worktree's, saying only why", async () => {
		// A command in the tree may point its .git anywhere; that is no
		// tree a repair mends, and git's advice to release it is left out,
		// since this is that release.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const elsewhere = join(scratchDir(), "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		rmSync(join(path, ".git"), { recursive: true, force: true });
		writeFileSync(join(path, ".git"), `gitdir: ${elsewhere}\n`);

		const released = await work({ action: "release", tree: key });

		const aside = released.details.aside;
		if (typeof aside !== "string") throw new Error(released.text);
		expect(released.text).toBe(
			`${GLYPH.named} Released ${key} by setting it aside whole at ${displayPath(aside)}: git won't run in it outside the sandbox, so what it holds couldn't be read, and every file in it was kept. Its .git was renamed. Where it led wasn't read, so whatever was committed in it may be there alone, on no branch of the checkout that cut it. Run no git in it, nor in any repository inside it: a command in the sandbox may have written the settings and hooks git would run. Git's refusal: its .git file names no worktree whose repository names it back, so git won't run there: a command may have pointed it at a git folder of its own.`,
		);
	});

	it("never says the branch stays for an entry whose repository lies inside the tree", async () => {
		// A command in the tree can lay out a repository there with an
		// entry naming the tree back; it goes aside with the tree, so no
		// branch anywhere keeps what was committed in it.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const repository = join(path, "r", ".git");
		const entry = join(repository, "worktrees", "x");
		mkdirSync(join(repository, "objects"), { recursive: true });
		mkdirSync(entry, { recursive: true });
		writeFileSync(join(entry, "gitdir"), `${join(path, ".git")}\n`);
		writeFileSync(join(entry, "commondir"), "../..\n");
		rmSync(join(path, ".git"), { recursive: true, force: true });
		writeFileSync(join(path, ".git"), `gitdir: ${entry}\n`);

		const released = await work({ action: "release", tree: key });

		if (typeof released.details.aside !== "string") {
			throw new Error(released.text);
		}
		expect(released.text).not.toContain("Its branch stays");
		expect(released.text).toContain("Where it led wasn't read");
		// The guard's words name the repository, a folder the command chose.
		expect(released.text).not.toContain(join("r", ".git"));
		expect(released.text).toMatch(
			/Git's refusal: it is a worktree of a repository the sandbox doesn't keep read-only/,
		);
	});

	it("says a tree cut from a checkout the fence doesn't guard keeps its branch there", async () => {
		// The case this answer exists for: an entry, in a repository
		// outside the tree, that names the tree back.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		pointAtEntry(path, outsideEntry(path));

		const released = await work({ action: "release", tree: key });

		const aside = released.details.aside;
		if (typeof aside !== "string") throw new Error(released.text);
		expect(released.text).toBe(
			`${GLYPH.named} Released ${key} by setting it aside whole at ${displayPath(aside)}: git won't run in it outside the sandbox, so what it holds couldn't be read, and every file in it was kept. Its .git was renamed so it no longer names git's entry for it. Its branch stays where it was, but that entry, with its index and HEAD, goes when the clone that cut it next cuts the name, or at \`git worktree prune\` there. Run no git in it, nor in any repository inside it: a command in the sandbox may have written the settings and hooks git would run. Git's refusal: it is a worktree of a repository the sandbox doesn't keep read-only, so a sandboxed command could have set what git runs there, and pi runs git outside the sandbox.`,
		);
	});

	it("says a snapshot's commits hang only from the entry's HEAD, as it kept no branch", async () => {
		cutWhereTheToolCuts();
		const commit = await git(checkout(), "rev-parse", "HEAD");
		const { details } = await work({
			action: "snapshot",
			repo: REPO,
			purpose: "read-it",
			commit,
		});
		const { key, path } = details;
		if (typeof key !== "string" || typeof path !== "string") {
			throw new Error(JSON.stringify(details));
		}
		pointAtEntry(path, outsideEntry(path));

		const released = await work({ action: "release", tree: key });

		if (typeof released.details.aside !== "string") {
			throw new Error(released.text);
		}
		expect(released.text).not.toContain("Its branch stays");
		expect(released.text).toContain(
			"It was a snapshot, on no branch, so anything committed in it is reachable only from that entry's HEAD, which goes when the clone that cut it next cuts the name, or at `git worktree prune` there: give such a commit a branch from that clone before then.",
		);
	});

	it("says a snapshot cut at a short id kept no branch either", async () => {
		// What it was cut as decides, not the form its commit was given in.
		cutWhereTheToolCuts();
		const commit = await git(checkout(), "rev-parse", "--short", "HEAD");
		const { details } = await work({
			action: "snapshot",
			repo: REPO,
			purpose: "read-short",
			commit,
		});
		const { key, path } = details;
		if (typeof key !== "string" || typeof path !== "string") {
			throw new Error(JSON.stringify(details));
		}
		pointAtEntry(path, outsideEntry(path));

		const released = await work({ action: "release", tree: key });

		if (typeof released.details.aside !== "string") {
			throw new Error(released.text);
		}
		expect(released.text).not.toContain("Its branch stays");
		expect(released.text).toContain("It was a snapshot, on no branch");
	});

	it("never says a link's commits are there alone when it leads out of the tree", async () => {
		// The repository it leads to keeps its commits where it stands.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const outside = join(scratchDir(), "elsewhere", ".git");
		mkdirSync(join(outside, "objects"), { recursive: true });
		rmSync(join(path, ".git"), { recursive: true, force: true });
		symlinkSync(outside, join(path, ".git"));

		const released = await work({ action: "release", tree: key });

		if (typeof released.details.aside !== "string") {
			throw new Error(released.text);
		}
		expect(released.text).not.toContain("is there alone");
		expect(released.text).toContain("Where it led wasn't read");
	});

	it("never says the branch stays for an entry whose commondir names a repository inside the tree", async () => {
		// Git takes the repository from commondir, so the commits went
		// where it names, which goes aside with the tree.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const inner = join(path, "inner", ".git");
		mkdirSync(join(inner, "objects"), { recursive: true });
		const entry = outsideEntry(path);
		writeFileSync(join(entry, "commondir"), `${inner}\n`);
		pointAtEntry(path, entry);

		const released = await work({ action: "release", tree: key });

		if (typeof released.details.aside !== "string") {
			throw new Error(released.text);
		}
		expect(released.text).not.toContain("Its branch stays");
		expect(released.text).toContain("Where it led wasn't read");
	});

	it("sets aside, rather than calling away, a tree whose repository's objects are a link to a folder", async () => {
		// As git-new-workdir lays one out: the guard reads its objects as
		// standing, so no repair waits on a checkout that never moved.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const entry = outsideEntry(path);
		const repository = dirname(dirname(entry));
		const store = join(scratchDir(), "store");
		mkdirSync(store, { recursive: true });
		rmSync(join(repository, "objects"), { recursive: true, force: true });
		symlinkSync(store, join(repository, "objects"));
		pointAtEntry(path, entry);

		const released = await work({ action: "release", tree: key });

		expect(typeof released.details.aside, released.text).toBe("string");
		expect(released.text).not.toContain("git worktree repair");
	});

	it("says a tree holding a repository of its own keeps its commits only in what was set aside", async () => {
		// No branch of the checkout holds what was committed in such a
		// .git, so the answer mustn't say the branch stays.
		cutWhereTheToolCuts();
		const { key } = await cut();

		const released = await work({ action: "release", tree: key });

		const aside = released.details.aside;
		if (typeof aside !== "string") throw new Error(released.text);
		expect(released.text).toBe(
			`${GLYPH.named} Released ${key} by setting it aside whole at ${displayPath(aside)}: git won't run in it outside the sandbox, so what it holds couldn't be read, and every file in it was kept. Its .git, a repository of its own rather than a worktree's, or a link to one, was renamed, and whatever was committed in it is there alone, on no branch of the checkout that cut it. Run no git in it, nor in any repository inside it: a command in the sandbox may have written the settings and hooks git would run. Git's refusal: it lies where the work tool cuts trees but holds a repository of its own rather than a worktree, so git won't run there.`,
		);
	});

	it("leaves a tree git won't run in to a session that still holds it", async () => {
		cutWhereTheToolCuts();
		const { key, path } = await unread();
		// The process that started this one runs throughout, so it stands
		// for another session holding the tree.
		const memory = createTreeMemory(treeRecordDir());
		const [record] = memory.recall();
		if (record === undefined) throw new Error("the cut left no record");
		const startedAt = await systemFacts.startedAt(process.ppid);
		if (startedAt === undefined) throw new Error("no start for the parent");
		memory.remember({
			...record,
			owners: [...(record.owners ?? []), { pid: process.ppid, startedAt }],
		});

		const released = await work({ action: "release", tree: key });

		expect(released).toEqual({
			text: `${GLYPH.named} Released ${key}, though 1 other session still holds it, so it stays at ${displayPath(path)} for them. Git won't run in it, so the last to release it sets it aside whole.`,
			details: { ok: true, released: key, kept: 1 },
		});
		expect(existsSync(join(path, ".git")), "nothing moved").toBe(true);
		expect(memory.recall()[0]?.owners).toEqual([
			{ pid: process.ppid, startedAt },
		]);
	});

	it("keeps a tree git won't run in whose git entry is locked by hand", async () => {
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		// A `.git` file naming an entry no repository names back is refused,
		// and its entry's lock says why somebody wants it kept.
		const entry = handLockable();
		writeFileSync(join(entry, "locked"), "on a stick\n");
		rmSync(join(path, ".git"), { recursive: true, force: true });
		writeFileSync(join(path, ".git"), `gitdir: ${entry}\n`);

		const released = await work({ action: "release", tree: key });

		expect(released.text).toBe(
			`${GLYPH.refused} ${displayPath(path)} is still held, and still there: ${HAND_LOCKED}.`,
		);
		expect(existsSync(join(path, ".git")), "nothing moved").toBe(true);
		expect(heldHere(), "this session still holds it").toBe(true);
	});

	it("lets a session go from a hand-locked tree git won't run in that another still holds", async () => {
		// Nothing moves while another holds it, so its lock asks nothing
		// of this session's share.
		cutWhereTheToolCuts();
		const { key, path } = await cut();
		const entry = handLockable();
		writeFileSync(join(entry, "locked"), "on a stick\n");
		rmSync(join(path, ".git"), { recursive: true, force: true });
		writeFileSync(join(path, ".git"), `gitdir: ${entry}\n`);
		const memory = createTreeMemory(treeRecordDir());
		const [record] = memory.recall();
		if (record === undefined) throw new Error("the cut left no record");
		const startedAt = await systemFacts.startedAt(process.ppid);
		if (startedAt === undefined) throw new Error("no start for the parent");
		memory.remember({
			...record,
			owners: [...(record.owners ?? []), { pid: process.ppid, startedAt }],
		});

		const released = await work({ action: "release", tree: key });

		expect(released.details).toEqual({ ok: true, released: key, kept: 1 });
		expect(existsSync(join(path, ".git")), "nothing moved").toBe(true);
		expect(memory.recall()[0]?.owners).toEqual([
			{ pid: process.ppid, startedAt },
		]);
	});

	it("leaves a tree cut elsewhere to its provider, though git won't run in it", async () => {
		// Another provider's tree is its own to take down: one moved
		// behind its back leaves it naming a folder that is gone.
		const { key, path } = await unread();

		const released = await work({ action: "release", tree: key });

		expect(released.text).toContain("is a link, which pi won't follow");
		expect(existsSync(path), "the tree is where it was").toBe(true);
		expect(heldHere(), "this session still holds it").toBe(true);
	});
});

/**
 * Whether the one tree's record names this session, so "still held"
 * means this session's hold rather than any record on the machine.
 */
function heldHere(): boolean {
	const [record] = createTreeMemory(treeRecordDir()).recall();
	return (record?.owners ?? []).some((owner) => owner.pid === process.pid);
}

/**
 * Cut a tree git won't run in: its `.git` a link, which the guard won't
 * follow, as it refuses a tree cut from a checkout the fence doesn't
 * guard.
 */
async function unread(): Promise<{ key: string; path: string }> {
	const tree = await cut();
	renameSync(join(tree.path, ".git"), join(tree.path, ".git-real"));
	symlinkSync(join(tree.path, ".git-real"), join(tree.path, ".git"));
	return tree;
}

/**
 * A worktree entry in a repository that stands, which names no tree
 * back, so a `.git` naming it is refused for the tree itself.
 */
function handLockable(): string {
	const repository = join(scratchDir(), "repo", ".git");
	mkdirSync(join(repository, "objects"), { recursive: true });
	const entry = join(repository, "worktrees", "entry");
	mkdirSync(entry, { recursive: true });
	return entry;
}

/**
 * A worktree entry, in a repository outside the tree that stands, naming
 * the tree at `path` back, as `git worktree add` leaves one.
 */
function outsideEntry(path: string): string {
	const entry = handLockable();
	writeFileSync(join(entry, "gitdir"), `${join(path, ".git")}\n`);
	writeFileSync(join(entry, "commondir"), "../..\n");
	return entry;
}

/** Make the tree at `path` a worktree whose `.git` names `entry`. */
function pointAtEntry(path: string, entry: string): void {
	rmSync(join(path, ".git"), { recursive: true, force: true });
	writeFileSync(join(path, ".git"), `gitdir: ${entry}\n`);
}

/** Whether anything stands at `path`, a link included. */
function existsLink(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		// Nothing there to stat.
		return false;
	}
}

describe("which tree a call means", () => {
	it("names what is held when the tree named is not", async () => {
		const { key } = await cut();
		const answer = await work({ action: "status", tree: "nope" });
		expect(answer.text).toContain(`${GLYPH.refused} No held tree called nope:`);
		expect(answer.text).toContain(key);
	});

	it("asks which when several are held and none is named", async () => {
		const first = await cut("first");
		const second = await cut("second");
		const answer = await work({ action: "status" });
		expect(answer.text).toBe(
			`${GLYPH.refused} Say which tree, by its key or its path. 2 are held: ${first.key}, ${second.key}.`,
		);
	});

	it("asks for a tree when none is held", async () => {
		expect((await work({ action: "status" })).text).toBe(
			`${GLYPH.refused} No tree is held. Ask for one with work tree, naming the repo, the branch and what it is for.`,
		);
	});
});
