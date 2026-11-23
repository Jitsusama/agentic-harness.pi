/**
 * Arriving on the machine a quest went to, through real git: a session's
 * done file waited for on a fake clock, its trees cloned or fetched with
 * their commits and changes, and its file placed where pi finds it.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ArrivalLine,
	arrive,
	type Clock,
} from "../../../../lib/internal/carry/arrive.ts";
import {
	type Carrying,
	carryAway,
} from "../../../../lib/internal/carry/carry-away.ts";
import {
	doneFileOf,
	readHandover,
} from "../../../../lib/internal/carry/handover.ts";
import type { CarriedNote } from "../../../../lib/internal/carry/notes.ts";
import { sessionFolderOf } from "../../../../lib/internal/quest/reopening/carried.ts";
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
const SESSION = "01a19111-arrive";

/** A clock that moves only as it is slept on, calling `at` each time. */
function fakeClock(at: (now: number) => void = () => {}): Clock {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			at(now);
		},
	};
}

/**
 * The leaving machine's session, carried: a tree at `~/src/app` on a
 * branch with a commit no remote has, a change, a file never added and a
 * session file, put in a handover folder. The session ran in the tree,
 * or in the folder `ranIn` names under the leaving home.
 */
async function carried(
	ranIn?: string,
	moved: Pick<Carrying, "fence" | "notes" | "largestFile"> = {},
	shaped: (tree: string) => Promise<void> = async () => {},
) {
	const origin = await bareOrigin(made);
	const leaving = folder(made, "leaving");
	const tree = await cloneAt(origin, join(leaving, "src", "app"));
	await git(tree, "checkout", "-q", "-b", "topic");
	await shaped(tree);
	const head = await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed, never committed\n");
	writeFileSync(join(tree, "draft.txt"), "never added\n");
	const cwd = ranIn === undefined ? tree : join(leaving, ranIn);
	mkdirSync(cwd, { recursive: true });
	const sessionFile = join(
		folder(made, "sessions"),
		`2026-11-07_${SESSION}.jsonl`,
	);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", id: SESSION, cwd })}\n${'{"type":"message"}\n'.repeat(500)}`,
	);
	const from = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
	await carryAway({
		exec,
		into: from,
		home: leaving,
		quest: QUEST,
		session: { id: SESSION, cwd, file: sessionFile },
		trees: [tree],
		...moved,
	});
	return { origin, from, head };
}

/** The quest's scratch the handover folder `from` lies in. */
function scratchOf(from: string): string {
	return dirname(dirname(from));
}

/** The `cwd` the session file placed for `cwd` in `store` names. */
function placedCwd(store: string, cwd: string): string {
	const placed = join(
		sessionFolderOf(store, cwd),
		`2026-11-07_${SESSION}.jsonl`,
	);
	return JSON.parse(readFileSync(placed, "utf8").split("\n")[0] ?? "").cwd;
}

/** Arrives on a machine whose home is `home`, keeping every line said. */
async function arriveAt(
	home: string,
	from: string,
	clock: Clock = fakeClock(),
	taken: CarriedNote[][] = [],
) {
	const said: ArrivalLine[] = [];
	const store = folder(made, "store");
	const whole = await arrive({
		takeNotes: async (quest, notes) => {
			expect(quest, "notes are taken up for the carried quest").toBe(QUEST);
			taken.push([...notes]);
			return notes.length;
		},
		exec,
		from,
		session: SESSION,
		home,
		scratch: scratchOf(from),
		sessions: store,
		clock,
		say: (line) => said.push(line),
	});
	return { whole, said, store };
}

describe("arriving with a carried session", () => {
	it("clones a tree that isn't here, with its commits and changes, and places its session", async () => {
		const { from, head } = await carried();
		const home = folder(made, "arriving");
		const tree = join(home, "src", "app");

		const { whole, said, store } = await arriveAt(home, from);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(said).toEqual([
			{ kind: "tree", path: tree, branch: "topic", did: "cloned" },
			{ kind: "sessions", sessions: [{ id: SESSION, cwd: tree }] },
		]);
		expect(await git(tree, "symbolic-ref", "--short", "HEAD")).toBe("topic");
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(join(tree, "README.md"), "utf8")).toBe(
			"changed, never committed\n",
		);
		expect(
			await git(tree, "status", "--porcelain"),
			"changed, and never added, as it was left",
		).toBe("M README.md\n?? draft.txt");
		const placed = join(
			sessionFolderOf(store, tree),
			`2026-11-07_${SESSION}.jsonl`,
		);
		expect(
			JSON.parse(readFileSync(placed, "utf8").split("\n")[0] ?? "").cwd,
		).toBe(tree);
	});

	it("clones from a repository beside it with the same origin, owing it nothing after", async () => {
		const { origin, from, head } = await carried();
		const home = folder(made, "arriving");
		const twin = await cloneAt(origin, join(home, "src", "twin"));
		await git(twin, "checkout", "-q", "-b", "mine");
		const only = await commit(twin, "mine.txt", "the twin's alone\n");
		const twinHead = await git(twin, "rev-parse", "HEAD");
		const tree = join(home, "src", "app");

		const { whole } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(
			await git(tree, "cat-file", "-t", only),
			"its objects came from the twin, not the origin",
		).toBe("commit");
		expect(
			existsSync(join(tree, ".git", "objects", "info", "alternates")),
			"it keeps its own objects rather than borrowing the twin's",
		).toBe(false);
		expect(
			await git(tree, "branch", "-a", "--format=%(refname)"),
			"the twin's own branch doesn't come as the origin's",
		).toBe("refs/heads/topic\nrefs/remotes/origin/main");
		expect(
			await git(twin, "status", "--porcelain"),
			"and the twin is left as it was",
		).toBe("");
		expect(await git(twin, "rev-parse", "HEAD")).toBe(twinHead);

		await git(twin, "checkout", "-q", "main");
		await git(twin, "branch", "-q", "-D", "mine");
		await git(twin, "reflog", "expire", "--expire=now", "--all");
		await git(twin, "gc", "-q", "--prune=now");
		expect(
			await git(tree, "fsck", "--no-progress", "--no-dangling"),
			"a gc in the twin leaves it whole",
		).toBe("");
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(
			await git(tree, "remote", "get-url", "origin"),
			"its origin is the carried one, not the twin",
		).toBe(origin);
	});

	it("takes from the origin a pushed commit its twin lacks", async () => {
		const home = folder(made, "arriving");
		const twinAt = join(home, "src", "twin");
		const { from, head } = await carried(undefined, {}, async (tree) => {
			const url = await git(tree, "remote", "get-url", "origin");
			await cloneAt(url, twinAt);
			await commit(tree, "pushed.txt", "pushed\n");
			await git(tree, "push", "-q", "origin", "topic");
		});
		const tree = join(home, "src", "app");

		const { whole } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(
			await git(tree, "cat-file", "-t", await git(twinAt, "rev-parse", "HEAD")),
			"cut from the twin",
		).toBe("commit");
		expect(
			await git(tree, "fsck", "--no-progress", "--no-dangling"),
			"and whole",
		).toBe("");
	});

	it("holds the twin's stale view of origin to origin's own branches", async () => {
		const home = folder(made, "arriving");
		const twinAt = join(home, "src", "twin");
		const elsewhere = join(folder(made, "elsewhere"), "src");
		const { from, head } = await carried(undefined, {}, async (tree) => {
			const url = await git(tree, "remote", "get-url", "origin");
			await git(tree, "push", "-q", "origin", "main:gone", "main:moved");
			await cloneAt(url, twinAt);
			await git(url, "branch", "-q", "-D", "gone");
			const other = await cloneAt(url, elsewhere);
			await git(other, "checkout", "-q", "moved");
			await commit(other, "moved.txt", "moved on, never here\n");
			await git(other, "push", "-q", "origin", "moved");
		});
		const tree = join(home, "src", "app");

		const { whole } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		const origin = await git(tree, "remote", "get-url", "origin");
		const theirs = await git(
			origin,
			"for-each-ref",
			"--format=%(refname:lstrip=2) %(objectname)",
			"refs/heads/",
		);
		const ours = await git(
			tree,
			"for-each-ref",
			"--format=%(refname:lstrip=3) %(objectname)",
			"refs/remotes/origin/",
		);
		expect(
			ours,
			"a branch origin deleted doesn't stay as origin's",
		).not.toMatch(/^gone /m);
		for (const line of ours.split("\n").filter(Boolean)) {
			expect(
				theirs.split("\n"),
				"each origin branch here is where origin has it",
			).toContain(line);
		}
	});

	it("lends a bare twin's own branches as origin's only where origin agrees", async () => {
		const home = folder(made, "arriving");
		const twinAt = join(home, "src", "twin.git");
		const { from, head } = await carried(undefined, {}, async (tree) => {
			const url = await git(tree, "remote", "get-url", "origin");
			await git(home, "clone", "-q", "--bare", url, twinAt);
			await git(twinAt, "branch", "mine", "main");
		});
		const tree = join(home, "src", "app");
		expect(
			await git(twinAt, "for-each-ref", "refs/remotes/"),
			"the twin has no view of origin of its own",
		).toBe("");

		const { whole } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(
			await git(tree, "for-each-ref", "--format=%(refname)", "refs/remotes/"),
			"origin's main comes, for fetches to say they have it; the twin's own doesn't",
		).toBe("refs/remotes/origin/main");
	});

	it("stands a tree it clones in the sparse checkout it left in", async () => {
		const { from } = await carried(undefined, {}, async (tree) => {
			mkdirSync(join(tree, "zone"));
			mkdirSync(join(tree, "elsewhere"));
			await commit(tree, "zone/kept.txt", "kept\n");
			await commit(tree, "elsewhere/left.txt", "left\n");
			await git(tree, "sparse-checkout", "set", "--cone", "zone");
		});
		const home = folder(made, "arriving");
		const tree = join(home, "src", "app");

		const { whole } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(tree, "sparse-checkout", "list")).toBe("zone");
		expect(existsSync(join(tree, "zone", "kept.txt")), "its zone is here").toBe(
			true,
		);
		expect(
			existsSync(join(tree, "elsewhere")),
			"what it never checked out isn't written here either",
		).toBe(false);
		expect(
			await git(tree, "status", "--porcelain"),
			"its changes came as they were left",
		).toBe("M README.md\n?? draft.txt");
	});

	it("unzips a session file carried gzipped and places it, leaving nothing in the scratch's tmp", async () => {
		const { from } = await carried(undefined, { largestFile: 1000 });
		const home = folder(made, "arriving");
		const tree = join(home, "src", "app");
		expect(
			readHandover(doneFileOf(from, SESSION))?.sessionFile,
			"it was carried gzipped",
		).toBe(`2026-11-07_${SESSION}.jsonl.gz`);

		const { whole, said, store } = await arriveAt(home, from);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: tree }],
		});
		expect(placedCwd(store, tree), "its file opens in the tree").toBe(tree);
		const tmp = join(scratchOf(from), "tmp");
		expect(
			existsSync(tmp) ? readdirSync(tmp) : [],
			"the unzipped copy is gone",
		).toEqual([]);
	});

	it("places nothing from a gzipped session file that won't unzip, saying why", async () => {
		const { from } = await carried(undefined, { largestFile: 1000 });
		writeFileSync(join(from, `2026-11-07_${SESSION}.jsonl.gz`), "not gzip\n");
		const home = folder(made, "arriving");

		const { whole, said, store } = await arriveAt(home, from);

		expect(whole, "a session not placed is not whole").toBe(false);
		const failed = said.find((line) => line.kind === "failed");
		expect(failed?.kind === "failed" ? failed.why : "").toContain(
			`2026-11-07_${SESSION}.jsonl.gz couldn't be placed: `,
		);
		expect(said.at(-1)).toEqual({ kind: "sessions", sessions: [] });
		expect(readdirSync(store), "nothing placed").toEqual([]);
		expect(readdirSync(join(scratchOf(from), "tmp"))).toEqual([]);
	});

	it("arrives in its quest's scratch when no tree it brought holds its folder, though that folder is here", async () => {
		const { from } = await carried("checkout/src");
		const home = folder(made, "arriving");
		const checkout = join(home, "checkout", "src");
		mkdirSync(checkout, { recursive: true });
		writeFileSync(join(checkout, "AGENTS.md"), "the person's own\n");
		const scratch = scratchOf(from);

		const { whole, said, store } = await arriveAt(home, from);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: scratch }],
		});
		expect(placedCwd(store, scratch), "its file opens in the scratch").toBe(
			scratch,
		);
		expect(
			readdirSync(store),
			"and is placed for no folder but the scratch",
		).toEqual([sessionFolderOf(store, scratch).slice(store.length + 1)]);
		expect(readdirSync(checkout), "the checkout is left as it was").toEqual([
			"AGENTS.md",
		]);
	});

	it("arrives in its scratch, making nothing, when its folder only shares a tree's name as a prefix", async () => {
		const { from } = await carried("src/app-notes");
		const home = folder(made, "arriving");

		const { said } = await arriveAt(home, from);

		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: scratchOf(from) }],
		});
		expect(
			existsSync(join(home, "src", "app-notes")),
			"no folder made beside the tree it only shares a prefix with",
		).toBe(false);
	});

	it("makes its folder within a tree it brought when the tree didn't carry it", async () => {
		const { from } = await carried("src/app/notes/today");
		const home = folder(made, "arriving");
		const notes = join(home, "src", "app", "notes", "today");

		const { said, store } = await arriveAt(home, from);

		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: notes }],
		});
		expect(existsSync(notes), "made, as the tree's own").toBe(true);
		expect(placedCwd(store, notes)).toBe(notes);
	});

	it("fetches into a tree already here from the same origin", async () => {
		const { origin, from, head } = await carried();
		const home = folder(made, "arriving");
		const tree = await cloneAt(origin, join(home, "src", "app"));

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(said[0]).toEqual({
			kind: "tree",
			path: tree,
			branch: "topic",
			did: "fetched",
		});
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
	});

	it("leaves a tree that already stands as carried, so arriving again does no harm", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		await arriveAt(home, from);

		const again = await arriveAt(home, from);

		expect(again.whole, "arriving a second time is whole too").toBe(true);
		expect(again.said[0]).toMatchObject({ did: "fetched" });
	});

	it("refuses a tree here from another origin, leaving it be", async () => {
		const { from } = await carried();
		const elsewhere = await bareOrigin(made);
		const home = folder(made, "arriving");
		const tree = await cloneAt(elsewhere, join(home, "src", "app"));

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "an arrival with a tree refused is not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: expect.stringContaining("another origin"),
		});
		expect(await git(tree, "symbolic-ref", "--short", "HEAD")).toBe("main");
	});

	it("refuses a tree here holding changes of its own, leaving them be", async () => {
		const { origin, from } = await carried();
		const home = folder(made, "arriving");
		const tree = await cloneAt(origin, join(home, "src", "app"));
		writeFileSync(join(tree, "mine.txt"), "mine\n");

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "an arrival with a tree refused is not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: expect.stringContaining("changes of its own"),
		});
		expect(readFileSync(join(tree, "mine.txt"), "utf8")).toBe("mine\n");
	});

	it("refuses a branch here holding commits the carried one lacks", async () => {
		const { origin, from } = await carried();
		const home = folder(made, "arriving");
		const tree = await cloneAt(origin, join(home, "src", "app"));
		await git(tree, "checkout", "-q", "-b", "topic");
		await commit(tree, "other.txt", "only here\n");
		await git(tree, "checkout", "-q", "main");

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "an arrival with a tree refused is not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: expect.stringContaining("commits the carried one lacks"),
		});
	});

	it("waits for a done file the share lands late, saying so each half minute", async () => {
		const { from } = await carried();
		const late = `${from}-landing`;
		renameSync(from, late);
		const clock = fakeClock((now) => {
			if (now === 65_000) renameSync(late, from);
		});

		const { whole, said } = await arriveAt(
			folder(made, "arriving"),
			from,
			clock,
		);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(
			said.flatMap((line) => (line.kind === "waiting" ? [line.waited] : [])),
		).toEqual([0, 30, 60]);
	});

	it("waits for every file the done file names, not the done file alone", async () => {
		const { from } = await carried();
		const bundle = JSON.parse(
			readFileSync(join(from, `${SESSION}.done.json`), "utf8"),
		).trees[0].bundle;
		renameSync(join(from, bundle), join(from, "..", bundle));
		const clock = fakeClock((now) => {
			if (now === 3_000)
				renameSync(join(from, "..", bundle), join(from, bundle));
		});

		const { whole, said } = await arriveAt(
			folder(made, "arriving"),
			from,
			clock,
		);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(said[0]).toMatchObject({
			kind: "waiting",
			lacking: [join(from, bundle)],
		});
	});

	it("gives up when nothing comes in ten minutes, and arrives with nothing", async () => {
		const from = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
		const home = folder(made, "arriving");

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "an arrival with a tree refused is not whole").toBe(false);
		expect(said.filter((line) => line.kind === "waiting")).toHaveLength(20);
		expect(said.at(-1)).toMatchObject({
			kind: "failed",
			why: expect.stringContaining("10 minutes"),
		});
		expect(existsSync(join(home, "src")), "nothing was cloned").toBe(false);
	});

	it("takes up its quest's notes before its session is placed", async () => {
		const notes = [{ text: "the gate is host-gate.sh", tags: ["gate"] }];
		const { from } = await carried(undefined, { fence: "fence", notes });
		const taken: CarriedNote[][] = [];

		const { whole, said } = await arriveAt(
			folder(made, "arriving"),
			from,
			fakeClock(),
			taken,
		);

		expect(whole, "it arrived whole").toBe(true);
		expect(taken).toEqual([notes]);
		expect(said.at(-1)).toMatchObject({ kind: "sessions" });
	});

	it("names the fence it ran under on its last line, for the node to start it under", async () => {
		const { from } = await carried(undefined, { fence: "strict" });
		const home = folder(made, "arriving");

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "it arrived whole").toBe(true);
		expect(said.at(-1)).toEqual({
			kind: "sessions",
			sessions: [{ id: SESSION, cwd: join(home, "src", "app") }],
			fence: "strict",
		});
	});

	it("says notes it couldn't take up, and doesn't call the arrival whole", async () => {
		const { from } = await carried(undefined, {
			notes: [{ text: "kept for later", tags: [] }],
		});
		const said: ArrivalLine[] = [];

		const whole = await arrive({
			exec,
			from,
			session: SESSION,
			home: folder(made, "arriving"),
			scratch: scratchOf(from),
			sessions: folder(made, "store"),
			clock: fakeClock(),
			say: (line) => said.push(line),
			takeNotes: async () => {
				throw new Error("database is locked");
			},
		});

		expect(whole, "an arrival without its notes is not whole").toBe(false);
		expect(said).toContainEqual({
			kind: "failed",
			why: "The quest's 1 notes weren't taken up: database is locked",
		});
	});
});
