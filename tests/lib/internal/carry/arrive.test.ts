/**
 * Arriving on the machine a quest went to, through real git: a session's
 * done file waited for on a fake clock, its trees cloned or fetched with
 * their commits and changes, and its file placed where pi finds it.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ArrivalLine,
	arrive,
	type Clock,
} from "../../../../lib/internal/carry/arrive.ts";
import { carryAway } from "../../../../lib/internal/carry/carry-away.ts";
import { sessionFolderOf } from "../../../../lib/internal/quest/carried.ts";
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
 * session file, put in a handover folder.
 */
async function carried() {
	const origin = await bareOrigin(made);
	const leaving = folder(made, "leaving");
	const tree = await cloneAt(origin, join(leaving, "src", "app"));
	await git(tree, "checkout", "-q", "-b", "topic");
	const head = await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed, never committed\n");
	writeFileSync(join(tree, "draft.txt"), "never added\n");
	const sessionFile = join(
		folder(made, "sessions"),
		`2026-11-07_${SESSION}.jsonl`,
	);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", id: SESSION, cwd: tree })}\n{"type":"message"}\n`,
	);
	const from = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
	await carryAway({
		exec,
		into: from,
		home: leaving,
		quest: QUEST,
		session: { id: SESSION, cwd: tree, file: sessionFile },
		trees: [tree],
	});
	return { origin, from, head };
}

/** Arrives on a machine whose home is `home`, keeping every line said. */
async function arriveAt(
	home: string,
	from: string,
	clock: Clock = fakeClock(),
) {
	const said: ArrivalLine[] = [];
	const store = folder(made, "store");
	const whole = await arrive({
		exec,
		from,
		session: SESSION,
		home,
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
});
