/**
 * Sweeping old snapshots another provider cut, which a session could
 * join while they are removed.
 *
 * A provider other than git's can't move a tree aside, so the sweep
 * holds a snapshot it takes, marked as being removed, while its
 * provider removes it. These race a session's ask against that removal
 * through a real broker and real tree records, and check the ask is
 * never handed the folder being removed.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Owner,
	type ProcessFacts,
	systemFacts,
} from "../../../../lib/core/process/index.ts";
import {
	createTreeBroker,
	type HeldTree,
	type TreeProvider,
} from "../../../../lib/core/work/broker.ts";
import {
	BeingRemoved,
	type TreeMemory,
} from "../../../../lib/core/work/memory.ts";
import {
	PUSHED_SETTLE_MS,
	sweepEndedTrees,
} from "../../../../lib/core/work/sweep.ts";
import {
	type TreeRequest,
	treeIdentity,
} from "../../../../lib/core/work/tree.ts";
import {
	disposeAll,
	ENDED,
	elsewhere,
	exec,
	RUNNING,
	settleFolder,
	setUp,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

/** The commit every snapshot here pins. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A request for a snapshot at {@link COMMIT}. */
const request: TreeRequest = {
	intent: "snapshot",
	repo: { key: "local:repo" },
	purpose: "review",
	commit: COMMIT,
};

/** How often a racing ask looks again, short so the races run fast. */
const LOOK_EVERY_MS = 10;

/** Long enough for an ask that would go wrong to have gone wrong. */
const LONG_ENOUGH_MS = 200;

/**
 * This test's own process with its real start, and {@link RUNNING}: the
 * broker judges a removal's holder by the machine's real answers, so a
 * sweep racing it must write itself down as the machine knows it.
 */
const machineAsItIs: ProcessFacts = {
	alive: (pid) => pid === process.pid || pid === RUNNING.pid,
	startedAt: async (pid) =>
		pid === process.pid
			? systemFacts.startedAt(pid)
			: pid === RUNNING.pid
				? RUNNING.startedAt
				: undefined,
};

/** A promise and the hand that settles it. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open = (): void => {};
	const opened = new Promise<void>((done) => {
		open = done;
	});
	return { opened, open };
}

/** Whether `promise` has settled within {@link LONG_ENOUGH_MS}. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
	const later = new Promise<false>((done) =>
		setTimeout(() => done(false), LONG_ENOUGH_MS),
	);
	return Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		later,
	]);
}

/** A records folder, a trees folder and an old snapshot elsewhere cut. */
async function oldSnapshot(owners: readonly Owner[] = [ENDED]) {
	const set = await setUp();
	const identity = treeIdentity(request);
	const tree = join(set.state, identity.key);
	mkdirSync(join(tree, "src"), { recursive: true });
	writeFileSync(join(tree, "src", "file"), "committed\n");
	set.memory.remember({
		identity,
		path: tree,
		providerId: "elsewhere",
		owners: [...owners],
	});
	settleFolder(tree);
	const record = join(set.state, "cut", `${identity.key}.json`);
	const then = new Date(Date.now() - 2 * PUSHED_SETTLE_MS);
	utimesSync(record, then, then);
	return { ...set, tree, record };
}

/** The record of the snapshot at `tree` as it is on disk now. */
function recordAt(memory: TreeMemory, tree: string): HeldTree | undefined {
	return memory.recall().find((one) => one.path === tree);
}

/**
 * A provider other than git's that removes a tree only once `removing`
 * is opened, saying when it starts by `started`, and cuts a snapshot in
 * the folder it always places it in, counting the cuts.
 */
function slowProvider(
	tree: string,
	removing: Promise<void>,
	started: () => void,
	removal: "removes" | "fails" = "removes",
): { provider: TreeProvider; cuts: string[] } {
	const cuts: string[] = [];
	const provider: TreeProvider = {
		...elsewhere(undefined),
		appliesTo: () => true,
		ensure: async () => {
			cuts.push(existsSync(tree) ? "readied" : "cut");
			mkdirSync(join(tree, "src"), { recursive: true });
			return { path: tree };
		},
		release: async (held) => {
			started();
			await removing;
			if (removal === "fails") throw new Error("its datastore is busy");
			rmSync(held.path, { recursive: true, force: true });
		},
	};
	return { provider, cuts };
}

describe("sweeping old snapshots another provider cut", () => {
	it("takes one nobody holds that sat a day, through its provider", async () => {
		const { memory, tree, sweepWith } = await oldSnapshot();
		const released: string[] = [];
		const provider = elsewhere(undefined, async (held) => {
			released.push(held.path);
			rmSync(held.path, { recursive: true, force: true });
		});

		const outcome = await sweepWith(provider);

		expect(outcome.taken).toEqual([{ path: tree }]);
		expect(released, "it isn't released through its provider").toEqual([tree]);
		expect(existsSync(tree), `${tree} is kept`).toBe(false);
		expect(recordAt(memory, tree), "its record stays").toBeUndefined();
	});

	it("marks it as being removed, held by the sweep alone, while its provider removes it", async () => {
		const { memory, tree, sweepWith } = await oldSnapshot();
		let during: HeldTree | undefined;
		const provider = elsewhere(undefined, async (held) => {
			during = recordAt(memory, tree);
			rmSync(held.path, { recursive: true, force: true });
		});

		await sweepWith(provider);

		expect(during?.removing, "it isn't marked").toBeTypeOf("number");
		expect(during?.owners?.map((one) => one.pid)).toEqual([process.pid]);
	});

	it("keeps one something still holds", async () => {
		const { tree, sweepWith } = await oldSnapshot();

		const outcome = await sweepWith(elsewhere(undefined), [tree]);

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "something still holds it",
		});
		expect(existsSync(tree), `${tree} is taken`).toBe(true);
	});

	it("never takes one a running session holds", async () => {
		const { tree, sweepWith } = await oldSnapshot([RUNNING]);

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.taken).toEqual([]);
		expect(existsSync(tree), `${tree} is taken`).toBe(true);
	});

	it("keeps one whose folder moved within the day", async () => {
		const { tree, sweepWith } = await oldSnapshot();
		writeFileSync(join(tree, "src", "built"), "built\n");

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "it moved within the last day, so a session may come back to it",
		});
		expect(existsSync(tree), `${tree} is taken`).toBe(true);
	});

	it("keeps one asked for within the day, since a read moves nothing", async () => {
		const { tree, record, sweepWith } = await oldSnapshot();
		const now = new Date();
		utimesSync(record, now, now);

		const outcome = await sweepWith(elsewhere(undefined));

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "it was asked for within the last day, so a session may come back to it",
		});
		expect(existsSync(tree), `${tree} is taken`).toBe(true);
	});

	it("keeps one its provider says isn't spent", async () => {
		const { tree, sweepWith } = await oldSnapshot();

		const outcome = await sweepWith(elsewhere("its processes still run"));

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "its processes still run",
		});
		expect(existsSync(tree), `${tree} is taken`).toBe(true);
	});

	it("keeps one a session took up after it was judged", async () => {
		const { memory, tree, sweepWith } = await oldSnapshot();
		const provider: TreeProvider = {
			...elsewhere(undefined),
			whyKept: async (held) => {
				memory.remember({ ...held, owners: [RUNNING] });
				return undefined;
			},
		};

		const outcome = await sweepWith(provider);

		expect(outcome.kept).toContainEqual({
			path: tree,
			why: "a session took it up again",
		});
		expect(existsSync(tree), `${tree} is taken`).toBe(true);
	});
});

describe("asking for a snapshot a sweep is removing", () => {
	/** Sweep with `provider`, judged by the machine as it is. */
	const sweepAsItIs = (
		set: Awaited<ReturnType<typeof oldSnapshot>>,
		provider: TreeProvider,
	) =>
		sweepEndedTrees({
			exec,
			memory: set.memory,
			claims: [],
			lockPath: set.lockPath,
			facts: machineAsItIs,
			providers: () => [provider],
		});

	it("waits for the removal, then cuts it afresh, never handed the folder being removed", async () => {
		const set = await oldSnapshot();
		const { memory, tree } = set;
		const removing = gate();
		const started = gate();
		const { provider, cuts } = slowProvider(
			tree,
			removing.opened,
			started.open,
		);
		const recut: string[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			recut: (was) => recut.push(was.path),
			removalWaitEveryMs: LOOK_EVERY_MS,
		});

		const sweeping = sweepAsItIs(set, provider);
		await started.opened;
		const asking = broker.ensure(request);
		const handedOut = await settlesSoon(asking);
		const askedMeanwhile = [...cuts];
		removing.open();
		const outcome = await sweeping;
		const held = await asking;

		expect(handedOut, "it is handed out while being removed").toBe(false);
		expect(askedMeanwhile, "its provider readied it meanwhile").toEqual([]);
		expect(outcome.taken).toEqual([{ path: tree }]);
		expect(cuts, "it isn't cut afresh once removed").toEqual(["cut"]);
		expect(held.path).toBe(tree);
		expect(recut, "asking again isn't said").toEqual([tree]);
		const record = recordAt(memory, tree);
		expect(record?.removing, "its record is still marked").toBeUndefined();
		expect(record?.owners?.map((one) => one.pid)).toEqual([process.pid]);
	});

	it("is refused under the record's lock while the removal runs", async () => {
		const set = await oldSnapshot();
		const { memory, tree } = set;
		const removing = gate();
		const started = gate();
		const { provider } = slowProvider(tree, removing.opened, started.open);

		const sweeping = sweepAsItIs(set, provider);
		await started.opened;
		const joining = memory.rememberHeldByUs({
			identity: treeIdentity(request),
			path: tree,
			providerId: "elsewhere",
		});
		await expect(joining).rejects.toBeInstanceOf(BeingRemoved);
		const owners = recordAt(memory, tree)?.owners?.map((one) => one.pid);
		removing.open();
		await sweeping;

		expect(owners, "the ask joined its holders").toHaveLength(1);
	});

	it("reuses it once the sweep puts it back after its removal fails", async () => {
		const set = await oldSnapshot();
		const { memory, tree } = set;
		const removing = gate();
		const started = gate();
		const { provider, cuts } = slowProvider(
			tree,
			removing.opened,
			started.open,
			"fails",
		);
		const recut: string[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			recut: (was) => recut.push(was.path),
			removalWaitEveryMs: LOOK_EVERY_MS,
		});

		const sweeping = sweepAsItIs(set, provider);
		await started.opened;
		const asking = broker.ensure(request);
		const handedOut = await settlesSoon(asking);
		removing.open();
		const outcome = await sweeping;
		const held = await asking;

		expect(handedOut, "it is handed out while being removed").toBe(false);
		expect(outcome.taken).toEqual([]);
		expect(cuts, "it isn't readied where it stands").toEqual(["readied"]);
		expect(held.path).toBe(tree);
		expect(recut, "asking again is said of a tree put back").toEqual([]);
		expect(recordAt(memory, tree)?.removing).toBeUndefined();
	});

	it("fails once the removal outlasts its wait, handing nothing out", async () => {
		const set = await oldSnapshot();
		const { memory, tree } = set;
		const removing = gate();
		const started = gate();
		const { provider, cuts } = slowProvider(
			tree,
			removing.opened,
			started.open,
		);
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			removalWaitMs: LONG_ENOUGH_MS,
			removalWaitEveryMs: LOOK_EVERY_MS,
		});

		const sweeping = sweepAsItIs(set, provider);
		await started.opened;
		const asking = broker.ensure(request);
		await expect(asking).rejects.toThrow(/still being removed by a sweep/);
		removing.open();
		await sweeping;

		expect(cuts, "its provider was asked").toEqual([]);
	});

	it("stops waiting when the ask is stopped", async () => {
		const set = await oldSnapshot();
		const { memory, tree } = set;
		const removing = gate();
		const started = gate();
		const { provider } = slowProvider(tree, removing.opened, started.open);
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			removalWaitEveryMs: LOOK_EVERY_MS,
		});
		const stop = new AbortController();

		const sweeping = sweepAsItIs(set, provider);
		await started.opened;
		const asking = broker.ensure(request, { signal: stop.signal });
		const handedOut = await settlesSoon(asking);
		stop.abort();
		await expect(asking).rejects.toThrow(
			"Stopped while waiting for a sweep removing this tree.",
		);
		removing.open();
		await sweeping;

		expect(handedOut, "it is handed out while being removed").toBe(false);
	});

	it("isn't held back by a mark whose sweep ended, and drops it", async () => {
		const { memory, tree, record } = await oldSnapshot();
		const marked = recordAt(memory, tree);
		if (marked === undefined) throw new Error(`${tree} has no record`);
		memory.remember({ ...marked, owners: [ENDED], removing: 1 });
		const { provider, cuts } = slowProvider(tree, Promise.resolve(), () => {});
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			removalWaitEveryMs: LOOK_EVERY_MS,
		});

		const held = await broker.ensure(request);

		expect(held.path).toBe(tree);
		expect(cuts, "it isn't readied where it stands").toEqual(["readied"]);
		const written = JSON.parse(readFileSync(record, "utf8"));
		expect(written.removing, "the mark stays").toBeUndefined();
	});
});
