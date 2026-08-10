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
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Owner, ProcessFacts } from "../../../lib/process/index.js";
import {
	createTreeBroker,
	type HeldTree,
	type TreeProvider,
} from "../../../lib/work/broker.js";
import { createTreeMemory } from "../../../lib/work/memory.js";
import type { TreeRequest } from "../../../lib/work/tree.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-memory-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

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
		expect(second.held()[0].identity.key).toBe(cut.identity.key);
		expect(second.held()[0].providerId).toBe("git");
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
		const gone = await second.release(second.held()[0]);

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
		expect(second.cutHere(mine.path)).toBe(true);
		expect(second.cutHere(inherited.path)).toBe(false);
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

		expect(second.held()[0].path).toBe(mine.path);
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
		expect(existsSync(join(dir, "half.json"))).toBe(true);
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
		const gone = await without.release(without.held()[0]);

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
		const gone = await other.release(other.held()[0]);

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
		await without.release(without.held()[0]);

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
		await without.release(without.held()[0]);

		const back = createTreeBroker({
			providers: [provider(released)],
			memory: memoryAt(),
		});
		const gone = await back.release(back.held()[0]);

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
		expect(one.cutHere(cut.path)).toBe(true);
		expect(createTreeBroker([provider()]).held()).toEqual([]);
	});
});

describe("a tree remembers which session cut it", () => {
	const memoryAt = () => createTreeMemory(join(root, "cut"));

	/** A tree on disk, held by this owner or by nobody recorded. */
	function tree(key: string, owner: Owner | undefined): HeldTree {
		// A real directory, since recall drops a record whose tree has
		// gone and would empty every one of these before the owner was
		// ever consulted.
		const path = join(root, key);
		mkdirSync(path, { recursive: true });
		return {
			identity: { key, shareable: true },
			path,
			providerId: "git",
			...(owner === undefined ? {} : { owner }),
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

	it("keeps a tree whose pid is alive under a different process", async () => {
		// A recycled pid is the case that makes a bare pid useless, and
		// it falls the dangerous way: the stranger is alive, so a check
		// reading only liveness calls this held forever.
		const memory = memoryAt();
		memory.remember(tree("ours", { pid: 4001, startedAt: 1000 }));

		const held = await memory.heldNow(machine({ 4001: 999_000 }));

		expect(held).toEqual([]);
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
		memory.remember(tree("older", undefined));

		const held = await memory.heldNow(machine({}));

		expect(held.map((one) => one.identity.key)).toEqual(["older"]);
	});
});
