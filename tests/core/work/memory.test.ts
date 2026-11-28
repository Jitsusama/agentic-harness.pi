/**
 * The fault here needed two sessions, so these tests use two brokers.
 *
 * Every existing broker test builds one broker and drives it, which is one
 * process, and the whole fault was that a tree outlives the process. So the suite
 * was green while `work status` on a tree that plainly existed answered "no held
 * tree: none are held", with commits inside it and no way back to them but the
 * `git worktree` call the guide forbids.
 *
 * A second broker over the same memory directory is what a second session is.
 * That is the shape to keep: if these ever collapse into one broker, they stop
 * testing the thing they exist for.
 *
 * Long because every way two sessions share one memory, who joins, who
 * leaves and who judges under the record's lock, is told here as one
 * story, and split by file it would lose the second broker each needs.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../../../lib/core/internal/file-lock.ts";
import {
	type Owner,
	ownerNow,
	type ProcessFacts,
	systemFacts,
} from "../../../lib/core/process/index.ts";
import {
	createTreeBroker,
	type HeldTree,
	type TreeProvider,
} from "../../../lib/core/work/broker.ts";
import {
	createTreeMemory,
	TreeGoing,
	TreeHalfGone,
} from "../../../lib/core/work/memory.ts";
import {
	type RemovalLock,
	removalLock,
} from "../../../lib/core/work/sweep-lock.ts";
import { type TreeRequest, treeIdentity } from "../../../lib/core/work/tree.ts";
import { at } from "../../support/at.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-memory-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

let locks = 0;

/**
 * A lock held as a sweep's run holds its own, by this process, so a mark
 * naming it stands until `end` is called.
 */
function running(): { readonly lock: RemovalLock; readonly end: () => void } {
	locks += 1;
	const made = removalLock(join(root, `sweep-${locks}.lock`));
	if (made === undefined) throw new Error("no lock could be made");
	return made;
}

/** A provider that makes the directory, so existence checks are real. */
function provider(released: string[] = []): TreeProvider {
	return {
		id: "git",
		specificity: 0,
		appliesTo: () => true,
		async ensure(request: TreeRequest) {
			const path = join(root, "trees", request.purpose);
			mkdirSync(path, { recursive: true });
			return { path };
		},
		async release(held) {
			released.push(held.path);
			rmSync(held.path, { recursive: true, force: true });
		},
	};
}

/**
 * A request for a tree.
 *
 * The branch is a parameter because a worktree's identity is its repo and its
 * branch, deliberately not its purpose: two requests for the same branch are the
 * same tree however differently they are described. Writing this test with one
 * branch and two purposes produced a confusing failure that turned out to be the
 * identity rule working correctly.
 */
function asked(purpose: string, branch = "topic"): TreeRequest {
	return {
		intent: "worktree",
		repo: { key: "github:o/r" },
		branch,
		purpose,
	};
}

describe("a tree outlives the session that cut it", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));

	it("is found by the next session", async () => {
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		// A new broker over the same directory. This is the whole point.
		const second = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});

		expect(second.held().map((one) => one.path)).toEqual([cut.path]);
		expect(second.held()[0]?.identity.key).toBe(cut.identity.key);
		expect(second.held()[0]?.providerId).toBe("git");
	});

	it("can be released by the session that did not cut it", async () => {
		// The half that made this urgent rather than untidy. Without it a tree
		// is not merely invisible, it is unreleasable: the only escape is the
		// git call the guide tells you never to make.
		const released: string[] = [];
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		const second = createTreeBroker({
			providers: [provider(released)],
			memory: memoryAt(),
		});
		const gone = await second.release(at(second.held(), 0));

		expect(gone.kind).toBe("released");
		expect(released).toEqual([cut.path]);
		expect(second.held()).toEqual([]);
		// And the record went with it, so it does not come back next session.
		expect(
			createTreeBroker({ providers: [provider()], memory: memoryAt() }).held(),
		).toEqual([]);
	});

	it("is reused rather than cut again", async () => {
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		const second = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const again = await second.ensure(asked("fix-410"));

		expect(again.path).toBe(cut.path);
		expect(second.held()).toHaveLength(1);
	});

	it("says which trees this session cut and which it inherited", async () => {
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const inherited = await first.ensure(asked("fix-410", "topic"));

		const second = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const mine = await second.ensure(asked("fix-411", "other"));

		// The distinction a listing needs: an inherited tree may hold work this
		// session knows nothing about, so it is the one to read status on first.
		expect(
			second.cutHere(mine.path),
			"the tree this session cut was cut here",
		).toBe(true);
		expect(
			second.cutHere(inherited.path),
			"the tree an earlier session cut was inherited, not cut here",
		).toBe(false);
	});

	it("lists this session's trees before the ones it inherited", async () => {
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		await first.ensure(asked("older", "topic"));

		const second = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const mine = await second.ensure(asked("newer", "other"));

		expect(second.held()[0]?.path).toBe(mine.path);
	});

	it("does not list the same tree twice", async () => {
		// A tree this session cut is also written down, so a naive union reports
		// one directory under two entries.
		const one = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		await one.ensure(asked("fix-410"));

		expect(one.held()).toHaveLength(1);
	});
});

describe("the directory is the truth, not the record", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));

	it("drops a record whose tree somebody deleted by hand", async () => {
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));
		rmSync(cut.path, { recursive: true, force: true });

		const second = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});

		// Somebody who cleaned up by hand has said something; a stale record has
		// not. So they stop being told about a tree they already dealt with.
		expect(second.held()).toEqual([]);
		expect(memoryAt().recall()).toEqual([]);
	});

	it("survives a record it cannot read", () => {
		// A half-written file, which a concurrent write can produce. Reporting a
		// tree with a broken identity is worse than not reporting it.
		const dir = join(root, "cut");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "half.json"), "{not json", "utf8");

		expect(memoryAt().recall()).toEqual([]);
		// And it is left alone rather than tidied away, since deleting somebody
		// else's file to clean up a listing is not this code's decision.
		expect(
			existsSync(join(dir, "half.json")),
			`${join(dir, "half.json")} is left alone`,
		).toBe(true);
	});

	it("ignores a record missing the identity a caller would rely on", () => {
		const dir = join(root, "cut");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "partial.json"),
			JSON.stringify({ path: root, providerId: "git" }),
			"utf8",
		);

		expect(memoryAt().recall()).toEqual([]);
	});
});

describe("a release that cannot happen says so", () => {
	// Found live, and the reason this is a discriminated answer rather than void.
	// A record naming a provider nobody registered used to drop the record and
	// return, and the tool reported "Released" about a directory still on disk and
	// still tracked by git, now with nothing able to name it. Reporting success
	// for doing nothing is the one outcome nobody can detect.
	const memoryAt = () => createTreeMemory(join(root, "cut"));

	it("does not claim to have released a tree nothing could remove", async () => {
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		// A session where the provider that cut it never loaded.
		const without = createTreeBroker({ providers: [], memory: memoryAt() });
		const gone = await without.release(at(without.held(), 0));

		expect(gone.kind).toBe("no-provider");
		if (gone.kind !== "no-provider") return;
		expect(gone.wanted).toBe("git");
		expect(gone.path).toBe(cut.path);
	});

	it("names what is registered, so a mismatched id reads as a correction", async () => {
		// This is how the live fault would have announced itself in one line. The
		// record said `git`; the provider is `git-worktree`. A refusal that names
		// both turns a wrong id into a typo somebody fixes.
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		await first.ensure(asked("fix-410"));

		const renamed: TreeProvider = { ...provider(), id: "git-worktree" };
		const other = createTreeBroker({
			providers: [renamed],
			memory: memoryAt(),
		});
		const gone = await other.release(at(other.held(), 0));

		if (gone.kind !== "no-provider") throw new Error("expected no-provider");
		expect(gone.registered).toEqual(["git-worktree"]);
	});

	it("keeps the record, so the tree can still be named later", async () => {
		// Dropping it is how a tree becomes garbage nothing can point at. A tree
		// that keeps appearing in a listing is recoverable once the provider
		// loads; one nobody has a record of is not.
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		const without = createTreeBroker({ providers: [], memory: memoryAt() });
		await without.release(at(without.held(), 0));

		expect(
			memoryAt()
				.recall()
				.map((one) => one.path),
		).toEqual([cut.path]);
		expect(without.held()).toHaveLength(1);
	});

	it("releases it once the provider is back", async () => {
		const released: string[] = [];
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		const without = createTreeBroker({ providers: [], memory: memoryAt() });
		await without.release(at(without.held(), 0));

		const back = createTreeBroker({
			providers: [provider(released)],
			memory: memoryAt(),
		});
		const gone = await back.release(at(back.held(), 0));

		expect(gone.kind).toBe("released");
		expect(released).toEqual([cut.path]);
	});
});

describe("a broker with no memory", () => {
	it("still works, and forgets as it always did", async () => {
		// Every existing caller passes providers positionally and wants nothing
		// to do with disk. That has to keep working, or this fix breaks far more
		// than it repairs.
		const one = createTreeBroker([provider()]);
		const cut = await one.ensure(asked("fix-410"));

		expect(one.held()).toHaveLength(1);
		expect(
			one.cutHere(cut.path),
			"a broker with no memory still knows the tree it cut",
		).toBe(true);
		expect(createTreeBroker([provider()]).held()).toEqual([]);
	});
});

describe("the broker answers for the trees it is actually using", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));

	it("records itself on a tree it reused, so a third session can tell", async () => {
		// The one that would have cost work, and it has to be asked from
		// a session that did not do the reusing. The reusing session is
		// safe either way, since it keeps its own list in memory; the
		// danger is every other session, which has only the record, and
		// the record still named the dead session that cut it. Tidy
		// there offers up the directory somebody is working in.
		//
		// An earlier version of this asked the reusing broker and passed
		// without the fix, which is the whole reason it is written this
		// way round.
		const first = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		const cut = await first.ensure(asked("fix-410"));

		// Rewrite the record as a session that has since died. Above the
		// system maximum, so nothing can be wearing it.
		memoryAt().remember({
			...cut,
			owners: [{ pid: 0x7f_ff_ff_ff, startedAt: 1 }],
		});

		const second = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		await second.ensure(asked("fix-410"));

		// A third session, holding nothing of its own, reading only what
		// is on disk.
		const third = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});

		expect((await third.stillHeld()).map((one) => one.path)).toContain(
			cut.path,
		);
	});

	it("stamps an owner on a tree as it cuts one", async () => {
		// The write half. Nothing else here can be true without it, and
		// it was the half with no test.
		const broker = createTreeBroker({
			providers: [provider()],
			memory: memoryAt(),
		});
		await broker.ensure(asked("fix-410"));

		const [written] = memoryAt().recall();
		expect(written?.owners?.[0]?.pid).toBe(process.pid);
	});

	it("names a record nobody's name is on", () => {
		// What every record on disk looks like today. It has to be told
		// apart from a claim, because it is the absence of one.
		const memory = memoryAt();
		const path = join(root, "from-before");
		mkdirSync(path, { recursive: true });
		memory.remember({
			identity: { key: "from-before", shareable: true },
			path,
			providerId: "git",
		});
		const broker = createTreeBroker({ providers: [provider()], memory });

		expect(broker.unattributed().map((one) => one.identity.key)).toEqual([
			"from-before",
		]);
	});
});

describe("a tree remembers which session cut it", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));

	/** A tree on disk, held by these owners or by nobody recorded. */
	function tree(key: string, ...owners: Owner[]): HeldTree {
		// A real directory, since recall drops a record whose tree has
		// gone and would empty every one of these before the owner was
		// ever consulted.
		const path = join(root, key);
		mkdirSync(path, { recursive: true });
		return {
			identity: { key, shareable: true },
			path,
			providerId: "git",
			...(owners.length === 0 ? {} : { owners }),
		};
	}

	/** A machine where these pids are running and these are not. */
	function machine(running: Record<number, number>): ProcessFacts {
		return {
			alive: (pid) => pid in running,
			startedAt: async (pid) => running[pid],
		};
	}

	it("leaves out a tree whose session is gone", async () => {
		// The whole point. Nothing released these trees because nothing
		// could tell a live hold from a dead one, so tidy answered
		// "something still holds it" for every tree ever cut and reclaim
		// could never take one. Measured before the fix: 59 records and
		// 649MB on one machine, growing by a snapshot per review round.
		const memory = memoryAt();
		memory.remember(tree("ours", { pid: 4001, startedAt: 1000 }));
		memory.remember(tree("theirs", { pid: 4002, startedAt: 2000 }));

		const held = await memory.heldNow(machine({ 4001: 1000 }));

		expect(held.map((one) => one.identity.key)).toEqual(["ours"]);
	});

	it("drops a tree whose pid is alive under a different process", async () => {
		// A recycled pid is the case that makes a bare pid useless, and
		// it falls the dangerous way: the stranger is alive, so a check
		// reading only liveness calls this held forever. Named for what
		// it asserts, which the first version of it was not.
		const memory = memoryAt();
		memory.remember(tree("ours", { pid: 4001, startedAt: 1000 }));

		const held = await memory.heldNow(machine({ 4001: 999_000 }));

		expect(held).toEqual([]);
	});

	it("keeps a shared tree while any one of its holders lives", async () => {
		// A snapshot is shareable, so two sessions can hold one tree.
		// With a single owner field the second to take it erased the
		// first, and the first is still working in there.
		const memory = memoryAt();
		memory.remember(
			tree(
				"shared",
				{ pid: 4001, startedAt: 1000 },
				{ pid: 4002, startedAt: 2000 },
			),
		);

		const held = await memory.heldNow(machine({ 4002: 2000 }));

		expect(held.map((one) => one.identity.key)).toEqual(["shared"]);
	});

	it("adds this session to a tree somebody else recorded", async () => {
		// Taking a shared tree is holding it, and the record has to say
		// so without dropping whoever was already there.
		const memory = memoryAt();
		const theirs = { pid: 4002, startedAt: 2000 };
		memory.remember(tree("shared", theirs));

		await memory.rememberHeldByUs(tree("shared", theirs), {
			alive: () => true,
			startedAt: async () => 5000,
		});

		expect(memory.recall()[0]?.owners).toEqual([
			theirs,
			{ pid: process.pid, startedAt: 5000 },
		]);
	});

	it("names this pi session on a tree it holds, and not once it lets go", async () => {
		// A session resumed after a restart runs in a new process, so the
		// session id is what still says the tree is its own.
		const memory = createTreeMemory(join(root, "cut"), {
			sessions: () => ["ours"],
		});
		const facts = { alive: () => true, startedAt: async () => 5000 };
		memory.remember({ ...tree("shared"), sessions: ["theirs"] });

		await memory.rememberHeldByUs(tree("shared"), facts);
		const holding = memory.recall()[0]?.sessions;
		await memory.forgetUsAsHolder(tree("shared").path, facts);

		expect(holding).toEqual(["theirs", "ours"]);
		expect(memory.recall()[0]?.sessions).toEqual(["theirs"]);
	});

	it("names a subagent's fleet session beside its own, once each", async () => {
		// A lane's own session ends with its job, while the session that
		// ran it goes on and sends the next job into the same tree.
		const memory = createTreeMemory(join(root, "cut"), {
			sessions: () => ["lane", "runner"],
		});
		const facts = { alive: () => true, startedAt: async () => 5000 };
		memory.remember({ ...tree("lane-tree"), sessions: ["runner"] });

		await memory.rememberHeldByUs(tree("lane-tree"), facts);

		expect(memory.recall()[0]?.sessions).toEqual(["lane", "runner"]);
	});

	it("does not let one stale record answer for a live one", async () => {
		// Two records naming one pid with different start times, which is
		// what a recycled pid looks like from here. Caching the verdict
		// rather than the fact let whichever was read first decide for
		// both, so the live session's tree read as gone.
		const memory = memoryAt();
		memory.remember(tree("stale", { pid: 4001, startedAt: 1000 }));
		memory.remember(tree("live", { pid: 4001, startedAt: 999_000 }));

		const held = await memory.heldNow(machine({ 4001: 999_000 }));

		expect(held.map((one) => one.identity.key)).toEqual(["live"]);
	});

	it("reads a record whose owners field is not a list", async () => {
		// A record is a file anybody can edit. Throwing out of the filter
		// took tidy and reclaim down for every repo over one bad file.
		const memory = memoryAt();
		const path = join(root, "broken");
		mkdirSync(path, { recursive: true });
		memory.remember({
			identity: { key: "broken", shareable: true },
			path,
			owners: {} as unknown as [],
			providerId: "git",
		});

		// Names nobody, so it is unattributable, which is held.
		expect(
			(await memory.heldNow(machine({}))).map((one) => one.identity.key),
		).toEqual(["broken"]);
		expect(memory.unattributed().map((one) => one.identity.key)).toEqual([
			"broken",
		]);
	});

	it("leaves a shared tree standing when another session still holds it", async () => {
		// Releasing our share is not taking the directory away. The only
		// door that always could remove a tree had to learn to read the
		// list this change started writing.
		const released: string[] = [];
		const memory = memoryAt();
		const broker = createTreeBroker({
			providers: [provider(released)],
			memory,
		});
		const cut = await broker.ensure(asked("fix-410"));
		// Somebody else took it too, and is genuinely still running. Pid
		// 1, read through the same facts everything else uses, because a
		// made-up start time reads as a recycled pid and is correctly
		// counted as gone: the first version of this test did that and
		// passed for the wrong reason.
		const init = await systemFacts.startedAt(1);
		if (init === undefined) throw new Error("the machine will not say");
		memory.remember({
			...cut,
			owners: [
				...(memory.recall()[0]?.owners ?? []),
				{ pid: 1, startedAt: init },
			],
		});

		const outcome = await broker.release(cut);

		expect(outcome).toEqual({ kind: "released", kept: 1 });
		expect(released).toEqual([]);
		expect(
			existsSync(cut.path),
			`${cut.path} is kept for its other owner`,
		).toBe(true);
	});

	it("asks the machine once per process, not once per record", async () => {
		// Every reviewer of one round shares a session, so the same
		// handful of pids recurs across the whole directory. Without
		// this, tidy forked `ps` once per record: 59 spawns on the
		// machine this was found on.
		const memory = memoryAt();
		const one = { pid: 4001, startedAt: 1000 };
		for (const key of ["a", "b", "c"]) memory.remember(tree(key, one));
		const asked: number[] = [];

		await memory.heldNow({
			alive: () => true,
			startedAt: async (pid) => {
				asked.push(pid);
				return 1000;
			},
		});

		expect(asked).toEqual([4001]);
	});

	it("keeps a tree it cannot decide about", async () => {
		// Alive, but the process table will not say since when. The
		// answer that costs work is the confident one, so an undecidable
		// owner stays held.
		const memory = memoryAt();
		memory.remember(tree("ours", { pid: 4001, startedAt: 1000 }));

		const held = await memory.heldNow({
			alive: () => true,
			startedAt: async () => undefined,
		});

		expect(held.map((one) => one.identity.key)).toEqual(["ours"]);
	});

	it("keeps a record written before owners existed", async () => {
		// Every record on disk today is one of these. Reading an absent
		// owner as "nobody's" would offer a live session's trees for
		// reclaiming on the first run of the new code, which is the one
		// outcome worse than the leak being fixed.
		const memory = memoryAt();
		memory.remember(tree("older"));

		const held = await memory.heldNow(machine({}));

		expect(held.map((one) => one.identity.key)).toEqual(["older"]);
	});

	it("takes a tree for this session once every session it names has ended", async () => {
		const memory = memoryAt();
		const spent = tree("spent", { pid: 4001, startedAt: 1000 });
		memory.remember(spent);

		const before = await memory.holdWhileUnheld(
			spent.path,
			running().lock,
			machine({ [process.pid]: 5000 }),
		);

		expect(before?.owners).toEqual([{ pid: 4001, startedAt: 1000 }]);
		expect(memory.recall()[0]?.owners).toEqual([
			{ pid: process.pid, startedAt: 5000 },
		]);
	});

	it("takes a tree this session alone holds, and forgets it", async () => {
		const memory = memoryAt();
		const ours = tree("ours", { pid: process.pid, startedAt: 5000 });
		memory.remember(ours);
		const taken: string[] = [];

		const kept = await memory.whileHeldAlone(
			ours.path,
			async () => {
				taken.push(ours.path);
			},
			machine({ [process.pid]: 5000 }),
		);

		expect(kept).toBe(0);
		expect(taken).toEqual([ours.path]);
		expect(memory.recall()).toEqual([]);
	});

	it("leaves a tree another running session holds, taking only this session off it", async () => {
		const memory = memoryAt();
		const ours = { pid: process.pid, startedAt: 5000 };
		const theirs = { pid: 4001, startedAt: 1000 };
		memory.remember(tree("shared", ours, theirs));
		const taken: string[] = [];

		const kept = await memory.whileHeldAlone(
			tree("shared").path,
			async () => {
				taken.push("shared");
			},
			machine({ 4001: 1000, [process.pid]: 5000 }),
		);

		expect(kept).toBe(1);
		expect(taken).toEqual([]);
		expect(memory.recall()[0]?.owners).toEqual([theirs]);
	});

	it("judges who holds a tree under its record's lock, so a session that joins after the look keeps it", async () => {
		// The record names this session alone when the caller looks; a
		// second joins while the record's lock is held elsewhere, before
		// the take is judged. Holders read before the lock would miss it.
		const memory = memoryAt();
		const ours = { pid: process.pid, startedAt: 5000 };
		const theirs = { pid: 4001, startedAt: 1000 };
		memory.remember(tree("joined", ours));
		const [file] = readdirSync(join(root, "cut")).filter((name) =>
			name.endsWith(".json"),
		);
		if (file === undefined) throw new Error("no record was written");
		const taken: string[] = [];
		let judged: Promise<number> | undefined;

		await withFileLock(join(root, "cut", file), async () => {
			judged = memory.whileHeldAlone(
				tree("joined").path,
				async () => {
					taken.push("joined");
				},
				machine({ 4001: 1000, [process.pid]: 5000 }),
			);
			// Long enough for anything read before the lock to be read.
			await new Promise((done) => setTimeout(done, 50));
			memory.remember(tree("joined", ours, theirs));
		});

		expect(await judged).toBe(1);
		expect(taken, "nothing moved").toEqual([]);
		expect(memory.recall()[0]?.owners).toEqual([theirs]);
	});

	it("takes nothing whose record went while it waited for the lock", async () => {
		// Another session gave it back first, and a new cut may stand there.
		const memory = memoryAt();
		memory.remember(tree("given", { pid: 4001, startedAt: 1000 }));
		const [file] = readdirSync(join(root, "cut")).filter((name) =>
			name.endsWith(".json"),
		);
		if (file === undefined) throw new Error("no record was written");
		const taken: string[] = [];
		let judged: Promise<number> | undefined;

		await withFileLock(join(root, "cut", file), async () => {
			judged = memory.whileHeldAlone(
				tree("given").path,
				async () => {
					taken.push("given");
				},
				machine({ [process.pid]: 5000 }),
			);
			// Long enough for anything read before the lock to be read.
			await new Promise((done) => setTimeout(done, 50));
			memory.forget(tree("given").path);
		});

		await expect(judged).rejects.toThrow(/its record went/);
		expect(taken, "nothing moved").toEqual([]);
	});

	it("takes a tree whose other holder has ended", async () => {
		// The usual leftover of a crash: the record names a session gone.
		const memory = memoryAt();
		memory.remember(
			tree(
				"leftover",
				{ pid: process.pid, startedAt: 5000 },
				{ pid: 4001, startedAt: 1000 },
			),
		);
		const taken: string[] = [];

		const kept = await memory.whileHeldAlone(
			tree("leftover").path,
			async () => {
				taken.push("leftover");
			},
			machine({ [process.pid]: 5000 }),
		);

		expect(kept).toBe(0);
		expect(taken).toEqual(["leftover"]);
		expect(memory.recall()).toEqual([]);
	});

	it("takes a tree with no record, since it names nobody else", async () => {
		const memory = memoryAt();
		const taken: string[] = [];

		const kept = await memory.whileHeldAlone(
			tree("unrecorded").path,
			async () => {
				taken.push("unrecorded");
			},
			machine({ [process.pid]: 5000 }),
		);

		expect(kept).toBe(0);
		expect(taken).toEqual(["unrecorded"]);
	});

	it("keeps the record of a tree whose take throws", async () => {
		const memory = memoryAt();
		const ours = tree("ours", { pid: process.pid, startedAt: 5000 });
		memory.remember(ours);

		await expect(
			memory.whileHeldAlone(
				ours.path,
				async () => {
					throw new Error("EXDEV: cross-device link not permitted");
				},
				machine({ [process.pid]: 5000 }),
			),
		).rejects.toThrow(/EXDEV/);
		expect(memory.recall().map((one) => one.identity.key)).toEqual(["ours"]);
	});

	it("won't take a tree a running session holds, or one that names nobody", async () => {
		const memory = memoryAt();
		const live = tree("live", { pid: 4001, startedAt: 1000 });
		const nobody = tree("nobody");
		memory.remember(live);
		memory.remember(nobody);
		const facts = machine({ 4001: 1000, [process.pid]: 5000 });

		const { lock } = running();
		expect(
			await memory.holdWhileUnheld(live.path, lock, facts),
		).toBeUndefined();
		expect(
			await memory.holdWhileUnheld(nobody.path, lock, facts),
		).toBeUndefined();
		expect(
			memory
				.recall()
				.map((one) => [one.identity.key, one.owners ?? []] as const),
		).toEqual(
			expect.arrayContaining([
				["live", [{ pid: 4001, startedAt: 1000 }]],
				["nobody", []],
			]),
		);
	});
});

describe("a tree a sweep is removing", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));
	const ENDED: Owner = { pid: 4001, startedAt: 1000 };
	const sweeping = (): ProcessFacts => ({
		alive: (pid) => pid === process.pid,
		startedAt: async (pid) => (pid === process.pid ? 5000 : undefined),
	});

	/** A shareable tree on disk whose one session has ended. */
	function ended(key: string): HeldTree {
		const path = join(root, key);
		mkdirSync(path, { recursive: true });
		return {
			identity: { key, shareable: true },
			path,
			providerId: "elsewhere",
			owners: [ENDED],
		};
	}

	it("is marked going, and answered as it was, unmarked", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		const { lock } = running();

		const before = await memory.holdWhileUnheld(tree.path, lock, sweeping());

		expect(before).toEqual(tree);
		expect(memory.recall()[0]?.going, "the record's mark").toEqual(
			expect.objectContaining({
				at: expect.any(Number),
				by: expect.objectContaining({ pid: process.pid }),
				lock,
			}),
		);
		expect(await memory.goingState(tree, sweeping()), "its state").toBe(
			"going",
		);
	});

	it("stays going while the process that marked it runs, whoever its record names", async () => {
		// In a host the record names the conversation the sweep runs in,
		// which may close while the removal goes on; the mark is the
		// process's, so the tree is handed to nobody meanwhile.
		const memory = memoryAt();
		const tree = ended("snapshot");
		const us: Owner = { pid: process.pid, startedAt: 5000 };
		memory.remember({
			...tree,
			owners: [ENDED],
			going: { at: Date.now(), by: us, lock: running().lock },
		});

		await expect(memory.rememberHeldByUs(tree, sweeping())).rejects.toThrow(
			TreeGoing,
		);
		expect(await memory.goingState(tree, sweeping())).toBe("going");
	});

	it("stays going however long its removal runs, until its lock goes", async () => {
		// A machine asleep through the night leaves the lock as it was, so an
		// age would read a removal still running as stopped.
		const memory = memoryAt();
		const tree = ended("snapshot");
		const us: Owner = { pid: process.pid, startedAt: 5000 };
		const { lock, end } = running();
		const sevenHours = 7 * 60 * 60 * 1000;
		memory.remember({
			...tree,
			going: { at: Date.now() - sevenHours, by: us, lock },
		});

		expect(await memory.goingState(tree, sweeping()), "while it runs").toBe(
			"going",
		);
		end();
		expect(await memory.goingState(tree, sweeping()), "once it ended").toBe(
			"standing",
		);
	});

	it("reads a mark whose lock went, or one this code never wrote, as stopped", async () => {
		const memory = memoryAt();
		const us: Owner = { pid: process.pid, startedAt: 5000 };
		const gone = running();
		gone.end();
		const { lock } = running();
		const marks: unknown[] = [
			{ at: Date.now(), by: us },
			{ at: Date.now(), by: us, lock: gone.lock },
			{ at: Date.now(), by: us, lock: { ...lock, id: "1:1" } },
			{ at: Date.now(), by: ENDED, lock },
			{ at: Date.now(), by: "a sweep", lock },
			{ at: 0, by: us, lock: "a lock" },
			Date.now(),
		];

		for (const [index, going] of marks.entries()) {
			const tree = ended(`snapshot-${index}`);
			memory.remember({ ...tree, going } as HeldTree);
			expect(
				await memory.goingState(tree, sweeping()),
				`the state under ${JSON.stringify(going)}`,
			).toBe("standing");
			rmSync(tree.path, { recursive: true, force: true });
		}
		// What the provider had left beside the folder is finished before a
		// fresh cut at its path, so each record stays, still read as stopped.
		expect(
			memory.recall().map((one) => one.identity.key),
			"records whose folders went",
		).toEqual(marks.map((_, index) => `snapshot-${index}`));
		for (const one of memory.recall()) {
			expect(
				await memory.goingState(one, sweeping()),
				`${one.identity.key} with its folder gone`,
			).toBe("standing");
		}
	});

	it("refuses a session joining it while its sweep runs, writing nothing", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());
		const marked = memory.recall()[0];

		await expect(memory.rememberHeldByUs(tree, sweeping())).rejects.toThrow(
			TreeGoing,
		);
		expect(memory.recall()[0], "the record").toEqual(marked);
	});

	it("refuses a session taking it up once its removal stopped partway, writing nothing", async () => {
		// What a stopped removal left may be half a tree, so nobody may work
		// in it until the removal is finished.
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember({
			...tree,
			owners: [ENDED],
			going: { at: Date.now(), by: ENDED },
		});
		const marked = memory.recall()[0];

		await expect(memory.rememberHeldByUs(tree, sweeping())).rejects.toThrow(
			TreeHalfGone,
		);
		expect(memory.recall()[0], "the record").toEqual(marked);
	});

	it("marks every record at its path, and refuses each while it goes", async () => {
		// World keeps one tree under two keys; marking the first alone left
		// the second to be handed out mid-removal.
		const memory = memoryAt();
		const tree = ended("snapshot");
		const other: HeldTree = {
			...tree,
			identity: { key: "snapshot-by-name", shareable: true },
		};
		memory.remember(tree);
		memory.remember(other);

		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());

		for (const one of [tree, other]) {
			const key = one.identity.key;
			expect(await memory.goingState(one, sweeping()), `${key}'s state`).toBe(
				"going",
			);
			await expect(
				memory.rememberHeldByUs(one, sweeping()),
				`${key} taken up`,
			).rejects.toThrow(TreeGoing);
		}
	});

	it("marks none of a path's records when one came under a key it didn't lock", async () => {
		// A session filing a twin after the sweep read the path holds only
		// the twin's lock, so a mark written beside it would go unseen.
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		let filed = false;
		const twinArrives: ProcessFacts = {
			...sweeping(),
			startedAt: async (pid) => {
				if (!filed) {
					filed = true;
					memory.remember({
						...tree,
						identity: { key: "snapshot-by-name", shareable: true },
					});
				}
				return sweeping().startedAt(pid);
			},
		};

		expect(
			await memory.holdWhileUnheld(tree.path, running().lock, twinArrives),
		).toBeUndefined();
		expect(filed, "the twin was filed meanwhile").toBe(true);
		expect(memory.recall().map((one) => one.going)).toEqual([
			undefined,
			undefined,
		]);
	});

	it("marks none of a path's records while a session holds any of them", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		const held: HeldTree = {
			...tree,
			identity: { key: "snapshot-by-name", shareable: true },
			owners: [{ pid: process.pid, startedAt: 5000 }],
		};
		memory.remember(tree);
		memory.remember(held);

		expect(
			await memory.holdWhileUnheld(tree.path, running().lock, sweeping()),
		).toBeUndefined();
		expect(memory.recall().map((one) => one.going)).toEqual([
			undefined,
			undefined,
		]);
	});

	it("isn't spent while its removal runs, so a second sweep leaves it", async () => {
		// In a host the record names the conversation the sweep runs in,
		// which may close while the removal goes on.
		const memory = memoryAt();
		const tree = ended("snapshot");
		const us: Owner = { pid: process.pid, startedAt: 5000 };
		memory.remember({
			...tree,
			owners: [ENDED],
			going: { at: Date.now(), by: us, lock: running().lock },
		});
		const taken: string[] = [];

		const second = await memory.holdWhileUnheld(
			tree.path,
			running().lock,
			sweeping(),
		);
		await memory.whileUnheld(
			tree.path,
			async () => {
				taken.push(tree.path);
				return true;
			},
			sweeping(),
		);

		expect(second, "the second sweep's hold").toBeUndefined();
		expect(taken, "what an unheld take took").toEqual([]);
	});

	it("keeps its record while the folder goes, until the sweep ends the removal", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());
		rmSync(tree.path, { recursive: true, force: true });

		expect(memory.recall().map((one) => one.path)).toEqual([tree.path]);
		await memory.endGoing(tree);
		expect(memory.recall()).toEqual([]);
	});

	it("leaves a mark another removal made since to that removal to end", async () => {
		// A sweep whose lock was taken over after a long stop ends what it
		// began; the sweep that took over may have marked the tree anew.
		const memory = memoryAt();
		const tree = ended("snapshot");
		const us: Owner = { pid: process.pid, startedAt: 5000 };
		const first = running().lock;
		const second = running().lock;
		const marked = { ...tree, going: { at: Date.now(), by: us, lock: second } };
		memory.remember(marked);

		await memory.endGoing(tree, false, first);
		await memory.endGoing(tree, true, first);

		expect(memory.recall(), "the second removal's record").toEqual([
			expect.objectContaining({ path: tree.path, going: marked.going }),
		]);
	});

	it("leaves the record marked as stopped when the removal fails", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		const { lock } = running();
		await memory.holdWhileUnheld(tree.path, lock, sweeping());

		await memory.endGoing(tree, true);

		const found = memory.recall()[0];
		expect(found?.going, "its mark").toEqual(
			expect.objectContaining({
				by: expect.objectContaining({ pid: process.pid }),
			}),
		);
		expect(found?.going?.lock, "its mark's lock").toBeUndefined();
		// The sweep held it only to remove it, so a session asking later
		// finishes the removal rather than reading the sweep as using it.
		expect(found?.owners ?? [], "its holders").toEqual([]);
		expect(await memory.goingState(tree, sweeping()), "its state").toBe(
			"standing",
		);
		await expect(memory.rememberHeldByUs(tree, sweeping())).rejects.toThrow(
			TreeHalfGone,
		);
	});

	it("finishes a stopped removal through the provider, and forgets it", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember({ ...tree, going: { at: Date.now(), by: ENDED } });
		let during: string | undefined;

		await memory.finishGoing(
			tree,
			async () => {
				during = await memory.goingState(tree, sweeping());
				rmSync(tree.path, { recursive: true, force: true });
			},
			sweeping(),
		);

		expect(during, "its state while finishing").toBe("going");
		expect(memory.recall(), "the records").toEqual([]);
		expect(
			readdirSync(join(root, "cut")).filter((name) =>
				name.endsWith(".removing"),
			),
			"locks left behind",
		).toEqual([]);
	});

	it("leaves a removal it couldn't finish stopped, and says why", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember({ ...tree, going: { at: Date.now(), by: ENDED } });

		await expect(
			memory.finishGoing(
				tree,
				async () => {
					throw new Error("EBUSY: the folder is in use");
				},
				sweeping(),
			),
		).rejects.toThrow(/EBUSY/);
		await expect(memory.rememberHeldByUs(tree, sweeping())).rejects.toThrow(
			TreeHalfGone,
		);
	});

	it("finishes nothing while another removal of it runs, or when none stopped", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		const other = ended("other");
		memory.remember(tree);
		memory.remember(other);
		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());
		const released: string[] = [];
		const release = async (): Promise<void> => {
			released.push("released");
		};

		await expect(
			memory.finishGoing(tree, release, sweeping()),
			"while its removal runs",
		).rejects.toThrow(TreeGoing);
		await memory.finishGoing(other, release, sweeping());

		expect(released, "the releases").toEqual([]);
		expect(memory.recall().find((one) => one.path === other.path)).toEqual(
			other,
		);
	});

	it("keeps when it was last asked for when the removal fails", async () => {
		// The record's file time is the shareable rule's clock; the mark and
		// the restore aren't asks, so neither may start its day again.
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		const [file] = readdirSync(join(root, "cut")).filter((name) =>
			name.endsWith(".json"),
		);
		if (file === undefined) throw new Error("no record was written");
		const asked = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		asked.setMilliseconds(0);
		utimesSync(join(root, "cut", file), asked, asked);
		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());

		await memory.endGoing(tree, true);

		expect(memory.askedAt(tree.path, tree.identity.key)).toBe(asked.getTime());
	});

	it("reads a record that never was as gone", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");

		expect(await memory.goingState(tree, sweeping())).toBe("gone");
		memory.remember(tree);
		expect(await memory.goingState(tree, sweeping())).toBe("standing");
	});

	it("leaves the record of a tree cut afresh where the removed one stood", async () => {
		const memory = memoryAt();
		const tree = ended("snapshot");
		memory.remember(tree);
		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());
		const fresh: HeldTree = {
			...tree,
			owners: [{ pid: 4002, startedAt: 2000 }],
		};
		memory.remember(fresh);

		await memory.endGoing(tree);
		await memory.endGoing(tree, true);

		expect(memory.recall()).toEqual([fresh]);
	});

	it("forgets only the records still marked, leaving a twin cut afresh", async () => {
		// World files one tree under two keys; once the folder went, either
		// may be a new cut's before the removal's end is written.
		const memory = memoryAt();
		const tree = ended("snapshot");
		const twin: HeldTree = {
			...tree,
			identity: { ...tree.identity, key: "twin-by-name" },
		};
		memory.remember(tree);
		memory.remember(twin);
		await memory.holdWhileUnheld(tree.path, running().lock, sweeping());
		const fresh: HeldTree = {
			...twin,
			owners: [{ pid: 4002, startedAt: 2000 }],
		};
		memory.remember(fresh);

		await memory.endGoing(tree);

		expect(memory.recall()).toEqual([fresh]);
	});
});

describe("a session asking for a tree a sweep is removing", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));
	/** A session no process on any machine can be. */
	const GONE: Owner = { pid: 2_147_483_646, startedAt: 1000 };

	/**
	 * A broker whose provider says, of each ask, whether a sweep was
	 * still removing the tree, and a record for `request`'s tree, cut by
	 * a session now gone, that the sweep has marked going.
	 */
	async function removing(request: TreeRequest, goingWaitMs: number) {
		const memory = memoryAt();
		const asks: boolean[] = [];
		const released: string[] = [];
		const made = provider(released);
		const broker = createTreeBroker({
			providers: [
				{
					...made,
					async ensure(asked, options) {
						asks.push(memory.recall().some((one) => one.going !== undefined));
						return made.ensure(asked, options);
					},
				},
			],
			memory,
			goingWaitMs,
		});
		const path = join(root, "trees", request.purpose);
		mkdirSync(path, { recursive: true });
		const tree: HeldTree = {
			identity: treeIdentity(request),
			path,
			providerId: "git",
			owners: [GONE],
		};
		memory.remember(tree);
		const sweep = running();
		const before = await memory.holdWhileUnheld(path, sweep.lock);
		if (before === undefined) throw new Error("the sweep didn't mark it");
		return { memory, broker, asks, released, tree, sweep };
	}

	/** After `ms`, as a sweep in another process ends its removal. */
	const later = (ms: number, then: () => Promise<unknown>): Promise<unknown> =>
		// A sweep's end is heard only by looking again, so the test waits as
		// a session would, on the clock.
		new Promise((done) => setTimeout(done, ms)).then(then);

	it("waits for the removal, then cuts the tree afresh, asking nothing while it goes", async () => {
		const request = asked("joined");
		const { memory, broker, asks, tree } = await removing(request, 5000);
		const started = Date.now();

		const [held] = await Promise.all([
			broker.ensure(request),
			later(100, async () => {
				rmSync(tree.path, { recursive: true, force: true });
				await memory.endGoing(tree);
			}),
		]);

		expect(Date.now() - started, "how long it waited").toBeGreaterThanOrEqual(
			90,
		);
		expect(held.path).toBe(tree.path);
		expect(existsSync(held.path), "the fresh cut's folder").toBe(true);
		expect(asks, "each ask, whether the tree was still going").toEqual([false]);
		expect(
			memory.recall()[0]?.going,
			"the fresh record's mark",
		).toBeUndefined();
	});

	it("finishes a removal that failed, then cuts the tree afresh", async () => {
		const request = asked("failed");
		const { memory, broker, asks, released, tree } = await removing(
			request,
			5000,
		);
		const started = Date.now();

		const [held] = await Promise.all([
			broker.ensure(request),
			later(100, () => memory.endGoing(tree, true)),
		]);

		expect(Date.now() - started, "how long it waited").toBeGreaterThanOrEqual(
			90,
		);
		expect(released, "what the provider released").toEqual([tree.path]);
		expect(held.path).toBe(tree.path);
		expect(asks, "each ask, whether the tree was still going").toEqual([false]);
		const found = memory.recall()[0];
		expect(found?.going, "the record's mark").toBeUndefined();
		expect(found?.owners?.map((one) => one.pid)).toContain(process.pid);
	});

	it("says the sweep is still at it once the wait runs out, asking nothing", async () => {
		const request = asked("stuck");
		const { broker, asks, tree } = await removing(request, 200);

		await expect(broker.ensure(request)).rejects.toThrow(
			`${tree.path} is still being removed by a sweep`,
		);
		expect(asks, "the provider's asks").toEqual([]);
	});

	it("stops looking once the wait runs out, whatever the record's own file says", async () => {
		// A record at the path left unmarked by older code reads as standing
		// while its twin's removal runs; each refusal is one look, so the
		// wait still ends.
		const request = asked("twin");
		const { memory, broker, asks, tree } = await removing(request, 200);
		const marked = memory.recall()[0];
		if (marked === undefined) throw new Error("no record was marked");
		memory.remember({
			...marked,
			identity: { ...marked.identity, key: "twin-by-name" },
		});
		const { going: _, ...unmarked } = marked;
		memory.remember(unmarked);
		const started = Date.now();

		await expect(broker.ensure(request)).rejects.toThrow(
			`${tree.path} is still being removed by a sweep`,
		);
		expect(Date.now() - started, "how long it looked").toBeLessThan(5000);
		expect(asks, "the provider's asks").toEqual([]);
	});

	it("finishes the removal at once when the sweep that marked it has stopped", async () => {
		const request = asked("stopped");
		const { memory, broker, asks, released, tree, sweep } = await removing(
			request,
			60_000,
		);
		sweep.end();
		const started = Date.now();

		const held = await broker.ensure(request);

		expect(Date.now() - started, "how long it waited").toBeLessThan(5000);
		expect(released, "what the provider released").toEqual([tree.path]);
		expect(held.path).toBe(tree.path);
		expect(asks, "each ask, whether the tree was still going").toEqual([false]);
		expect(memory.recall()[0]?.going, "the stopped mark").toBeUndefined();
	});

	it("cuts afresh a tree whose stopped removal fails to finish once its folder is gone", async () => {
		// Git's release runs `worktree remove` on the folder, which fails once
		// it is gone: kept stopped, every ask would finish it again and fail.
		const request = asked("folder-gone");
		const memory = memoryAt();
		const released: string[] = [];
		const broker = createTreeBroker({
			providers: [
				{
					...provider(),
					async release(held) {
						released.push(held.path);
						throw new Error(`fatal: '${held.path}' is not a working tree`);
					},
				},
			],
			memory,
			goingWaitMs: 5000,
		});
		const path = join(root, "trees", request.purpose);
		memory.remember({
			identity: treeIdentity(request),
			path,
			providerId: "git",
			owners: [GONE],
			going: { at: Date.now(), by: GONE },
		});

		const held = await broker.ensure(request);

		expect(released, "what the provider was asked to release").toEqual([path]);
		expect(held.path, "where the tree was handed out").toBe(path);
		expect(existsSync(path), "the fresh cut's folder").toBe(true);
		const found = memory.recall();
		expect(
			found.map((one) => one.going),
			"the marks on its records",
		).toEqual([undefined]);
		expect(
			found[0]?.owners?.map((one) => one.pid),
			"its record's holders",
		).toContain(process.pid);
	});

	it("waits while another session finishes a stopped removal, then cuts afresh", async () => {
		// The other session holds the removal's lock, so this one can't take
		// the removal up; that is a removal still going, not a refusal.
		const request = asked("finished-elsewhere");
		const { memory, broker, asks, released, tree, sweep } = await removing(
			request,
			5000,
		);
		sweep.end();
		const file = `${tree.identity.key.replaceAll("/", "-")}.json.removing`;
		const theirs = removalLock(join(root, "cut", file));
		if (theirs === undefined)
			throw new Error("the other session's lock wasn't made");
		const started = Date.now();

		const [held] = await Promise.all([
			broker.ensure(request),
			later(100, async () => {
				rmSync(tree.path, { recursive: true, force: true });
				await memory.endGoing(tree);
				theirs.end();
			}),
		]);

		expect(Date.now() - started, "how long it waited").toBeGreaterThanOrEqual(
			90,
		);
		expect(released, "what this session's provider released").toEqual([]);
		expect(held.path).toBe(tree.path);
		expect(existsSync(held.path), "the fresh cut's folder").toBe(true);
		expect(asks, "each ask, whether the tree was still going").toEqual([false]);
	});

	it("refuses a worktree another running session took up while it waited", async () => {
		// A worktree is one session's at a time; the wait doesn't excuse the
		// look at who else holds it.
		const request = asked("taken-meanwhile");
		const { memory, broker, asks, tree } = await removing(request, 5000);
		const theirs = await ownerNow(systemFacts, process.ppid);
		if (theirs === undefined)
			throw new Error("the parent process can't be read");

		await Promise.all([
			expect(broker.ensure(request)).rejects.toThrow("another running session"),
			later(100, async () => {
				await memory.endGoing(tree);
				memory.remember({ ...tree, owners: [theirs] });
			}),
		]);
		expect(asks, "the provider's asks").toEqual([]);
		expect(memory.recall()[0]?.owners, "its holders").toEqual([theirs]);
	});

	it("stops waiting when its call is called off", async () => {
		const request = asked("called-off");
		const { broker, asks } = await removing(request, 60_000);
		const stop = new AbortController();
		const started = Date.now();

		await Promise.all([
			expect(broker.ensure(request, { signal: stop.signal })).rejects.toThrow(),
			later(100, async () => {
				stop.abort();
			}),
		]);
		expect(Date.now() - started, "how long it waited").toBeLessThan(5000);
		expect(asks, "the provider's asks").toEqual([]);
	});
});
