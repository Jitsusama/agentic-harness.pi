import { describe, expect, it } from "vitest";
import type { RepoLocator } from "../../../lib/core/review/index.ts";
import {
	createTreeBroker,
	type HeldTree,
	type TreeProvider,
} from "../../../lib/core/work/broker.ts";
import type { TreeMemory } from "../../../lib/core/work/memory.ts";
import { type TreeRequest, treeIdentity } from "../../../lib/core/work/tree.ts";

const world: RepoLocator = { key: "github:Shopify/world" };
const elsewhere: RepoLocator = { key: "github:Jitsusama/other" };

const snapshot = (commit: string): TreeRequest => ({
	intent: "snapshot",
	repo: world,
	purpose: "Shopify/world#42",
	commit,
});

/**
 * Records every cut it was asked to make, so reuse is observable. Like
 * a real provider, it answers a request it has placed before with the
 * same path, and one placed by a record it is shown in `placed`.
 */
function fakeProvider(
	id: string,
	specificity = 0,
	applies: (repo: RepoLocator) => boolean = () => true,
	placed: ReadonlyMap<string, string> = new Map(),
) {
	const cuts: TreeRequest[] = [];
	const released: string[] = [];
	const paths = new Map(placed);
	const provider: TreeProvider = {
		id,
		specificity,
		appliesTo: applies,
		async ensure(request) {
			cuts.push(request);
			const key = treeIdentity(request).key;
			const path = paths.get(key) ?? `/trees/${id}/${cuts.length}`;
			paths.set(key, path);
			return { path };
		},
		async release(held) {
			released.push(held.path);
		},
	};
	return { provider, cuts, released };
}

const worktree = (branch: string): TreeRequest => ({
	intent: "worktree",
	repo: world,
	purpose: branch,
	branch,
});

/** A memory holding one remembered tree, with whoever else holds it. */
function remembering(held: HeldTree, others: number[]): TreeMemory {
	const owners = others.map((pid) => ({ pid, startedAt: 1 }));
	return {
		remember: () => {},
		rememberHeldByUs: async () => {},
		forget: () => {},
		recall: () => [held],
		heldNow: async () => [held],
		unattributed: () => [],
		otherHolders: async (path) => (path === held.path ? owners : []),
		heldByUs: async () => new Set(),
		forgetUsAsHolder: async () => {},
		whileHeldAlone: async (path, take) => {
			if (path === held.path && owners.length > 0) return owners.length;
			await take();
			return 0;
		},
		whileUnheld: async () => undefined,
		holdWhileUnheld: async () => undefined,
		whileUnusedSince: async () => undefined,
		askedAt: () => undefined,
		reownSession: async () => 0,
	};
}

describe("a worktree somebody else is working in", () => {
	const request = worktree("topic");
	const theirs: HeldTree = {
		identity: treeIdentity(request),
		path: "/trees/theirs",
		providerId: "git-worktree",
	};

	it("is refused while another running session holds it", async () => {
		// A worktree is one session's: its uncommitted work is that
		// session's, and a second one writing there loses it. Handing it
		// over once gave one stream another's half-done change.
		const { provider, cuts } = fakeProvider("git-worktree");
		const broker = createTreeBroker({
			providers: [provider],
			memory: remembering(theirs, [4242]),
		});

		await expect(broker.ensure(request)).rejects.toThrow(
			/\/trees\/theirs.*pid 4242.*different branch/s,
		);
		expect(cuts).toHaveLength(0);
	});

	it("is taken over once nobody running holds it", async () => {
		const { provider } = fakeProvider(
			"git-worktree",
			0,
			undefined,
			new Map([[theirs.identity.key, theirs.path]]),
		);
		const broker = createTreeBroker({
			providers: [provider],
			memory: remembering(theirs, []),
		});

		const held = await broker.ensure(request);

		expect(held.path).toBe("/trees/theirs");
	});

	it("does not stop a snapshot being shared", async () => {
		const commit = snapshot("abc123");
		const shared: HeldTree = {
			identity: treeIdentity(commit),
			path: "/trees/shared",
			providerId: "git-worktree",
		};
		const { provider } = fakeProvider(
			"git-worktree",
			0,
			undefined,
			new Map([[shared.identity.key, shared.path]]),
		);
		const broker = createTreeBroker({
			providers: [provider],
			memory: remembering(shared, [4242]),
		});

		const held = await broker.ensure(commit);

		expect(held.path).toBe("/trees/shared");
	});

	it("cuts a snapshot afresh when a sweep took it as it was joined", async () => {
		const commit = snapshot("abc123");
		const shared: HeldTree = {
			identity: treeIdentity(commit),
			path: "/trees/shared",
			providerId: "git-worktree",
		};
		const { provider, cuts } = fakeProvider(
			"git-worktree",
			0,
			undefined,
			new Map([[shared.identity.key, shared.path]]),
		);
		// The sweep takes the tree after the provider found it and before
		// this session's owner is written, so the first write finds it gone.
		let writes = 0;
		const memory: TreeMemory = {
			...remembering(shared, []),
			rememberHeldByUs: async () => {
				writes += 1;
			},
			recall: () => (writes === 1 ? [] : [shared]),
		};
		const recut: string[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			recut: (was) => recut.push(was.path),
		});

		const held = await broker.ensure(commit);

		expect(held.path).toBe("/trees/shared");
		expect(recut, "the fresh cut isn't said").toEqual(["/trees/shared"]);
		expect(
			cuts,
			"the provider is asked once to find it, once to cut it",
		).toHaveLength(2);
		expect(writes, "the fresh cut is written down as ours").toBe(2);
	});

	it("cuts afresh a snapshot this session cut when a sweep took it as it was asked again", async () => {
		// A sweep takes a snapshot its own session left unused, so the
		// race above reaches this session's own trees too.
		const commit = snapshot("abc123");
		const { provider, cuts } = fakeProvider("git-worktree");
		let writes = 0;
		let cut: HeldTree | undefined;
		const memory: TreeMemory = {
			...remembering(
				{ identity: treeIdentity(commit), path: "", providerId: "" },
				[],
			),
			rememberHeldByUs: async (tree) => {
				writes += 1;
				cut = tree;
			},
			// Written once, then taken between the provider finding it
			// again and the second write.
			recall: () => (writes === 1 && cut ? [cut] : []),
		};
		const recut: string[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			recut: (was) => recut.push(was.path),
		});

		const first = await broker.ensure(commit);
		await broker.ensure(commit);

		expect(recut, "the fresh cut isn't said").toEqual([first.path]);
		expect(cuts, "it isn't cut afresh").toHaveLength(3);
	});

	it("lists no tree of its own whose folder has gone, and says it is cut afresh", async () => {
		// A sweep tells no broker what it took, so this session's own list
		// named a gone folder as cut, and attaching a change again sent its
		// readers to a missing directory.
		const commit = snapshot("abc123");
		const { provider, cuts } = fakeProvider("git-worktree");
		const gone = new Set<string>();
		const recut: string[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			recut: (was) => recut.push(was.path),
			stands: (path) => !gone.has(path),
		});

		const first = await broker.ensure(commit);
		gone.add(first.path);
		const listed = broker.held().map((tree) => tree.path);
		await broker.ensure(commit);

		expect(listed, "a gone folder is listed as held").toEqual([]);
		expect(recut, "the fresh cut isn't said").toEqual([first.path]);
		expect(cuts, "it isn't cut afresh").toHaveLength(2);
	});

	// Attaching a change sends a reader to a held snapshot by path, and
	// a sweep judges a snapshot's use by its last ask.
	it("dates a use it is told of as an ask, asking no provider, and holds the tree", async () => {
		const theirs: HeldTree = {
			identity: treeIdentity(snapshot("abc123")),
			path: "/trees/theirs",
			providerId: "git-worktree",
		};
		const { provider, cuts } = fakeProvider("git-worktree");
		const dated: string[] = [];
		const memory: TreeMemory = {
			...remembering(theirs, []),
			rememberHeldByUs: async (tree) => {
				dated.push(tree.path);
			},
		};
		const broker = createTreeBroker({ providers: [provider], memory });

		const stands = await broker.used(theirs);

		expect(stands, "a standing tree reads as gone").toBe(true);
		expect(dated, "its use isn't dated").toEqual(["/trees/theirs"]);
		expect(cuts, "a provider was asked").toHaveLength(0);
		expect(broker.cutHere("/trees/theirs"), "it isn't held here").toBe(true);
	});

	it("says a tree a sweep took before its use was dated is gone, and drops it", async () => {
		const theirs: HeldTree = {
			identity: treeIdentity(snapshot("abc123")),
			path: "/trees/theirs",
			providerId: "git-worktree",
		};
		const { provider } = fakeProvider("git-worktree");
		const memory: TreeMemory = {
			...remembering(theirs, []),
			rememberHeldByUs: async () => {},
			recall: () => [],
		};
		const broker = createTreeBroker({ providers: [provider], memory });

		const stands = await broker.used(theirs);

		expect(stands, "a taken tree reads as standing").toBe(false);
		expect(broker.cutHere("/trees/theirs"), "a taken tree is held here").toBe(
			false,
		);
	});

	it("reads whether a tree stands only once its use is written, so a take meanwhile is seen", async () => {
		// The sweep judges under the record's lock, so only a reading after
		// the write sees a take made while the write waited for it.
		const theirs: HeldTree = {
			identity: treeIdentity(snapshot("abc123")),
			path: "/trees/theirs",
			providerId: "git-worktree",
		};
		const { provider } = fakeProvider("git-worktree");
		let written = false;
		const memory: TreeMemory = {
			...remembering(theirs, []),
			rememberHeldByUs: async () => {
				written = true;
			},
			recall: () => (written ? [] : [theirs]),
		};
		const recut: string[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			memory,
			recut: (was) => recut.push(was.path),
		});

		const stands = await broker.used(theirs);
		await broker.ensure(snapshot("abc123"));

		expect(
			stands,
			"a tree taken while its use was written reads as standing",
		).toBe(false);
		expect(recut, "asking again for a tree found gone isn't said").toEqual([
			"/trees/theirs",
		]);
	});
});

describe("createTreeBroker", () => {
	it("cuts a tree through the provider that serves the repo", async () => {
		const { provider, cuts } = fakeProvider("git-worktree");
		const broker = createTreeBroker([provider]);

		const held = await broker.ensure(snapshot("abc123"));

		expect(held.path).toBe("/trees/git-worktree/1");
		expect(held.providerId).toBe("git-worktree");
		expect(cuts).toHaveLength(1);
	});

	it("reuses a tree that already answers the request", async () => {
		const { provider, cuts } = fakeProvider("git-worktree");
		const broker = createTreeBroker([provider]);

		const first = await broker.ensure(snapshot("abc123"));
		const second = await broker.ensure(snapshot("abc123"));

		// One tree, handed back both times.
		expect(second).toEqual(first);
		// And the provider asked again, which is not a second cut: every
		// provider treats already-there as the ordinary case, and the
		// built-in one uses the second call to check the tree still
		// stands at the commit its name claims. Returning on the record
		// alone made that check unreachable for precisely the trees that
		// had drifted, since a drifted tree is one somebody cut earlier.
		expect(cuts).toHaveLength(2);
	});

	it("asks the provider again about a tree it already remembers", async () => {
		// The provider is where the knowledge of what a correct tree
		// looks like lives. A World snapshot left standing on main by an
		// older version of its provider could never be pinned, because
		// the pinning code sat behind a branch nothing reached once a
		// record existed.
		const { provider } = fakeProvider("git-worktree");
		const asked: TreeRequest[] = [];
		const watching: TreeProvider = {
			...provider,
			async ensure(request) {
				asked.push(request);
				return { path: "/trees/pinned" };
			},
		};
		const broker = createTreeBroker([watching]);

		await broker.ensure(snapshot("abc123"));
		await broker.ensure(snapshot("abc123"));

		expect(asked).toHaveLength(2);
	});

	it("follows the provider to where a remembered tree is now, and writes that down", async () => {
		// World's provider once handed back a tree's container and now
		// hands back the checkout inside it. A record from before kept
		// every status and release running git in the container.
		const request = worktree("main");
		const old: HeldTree = {
			identity: treeIdentity(request),
			path: "/trees/w-main",
			providerId: "world-dev-tree",
			owners: [{ pid: 1, startedAt: 1 }],
		};
		const { provider } = fakeProvider(
			"world-dev-tree",
			0,
			undefined,
			new Map([[old.identity.key, "/trees/w-main/src"]]),
		);
		const written: HeldTree[] = [];
		const broker = createTreeBroker({
			providers: [provider],
			memory: {
				...remembering(old, []),
				rememberHeldByUs: async (held) => {
					written.push(held);
				},
			},
		});

		const held = await broker.ensure(request);

		expect(held.path).toBe("/trees/w-main/src");
		expect(written).toEqual([{ ...old, path: "/trees/w-main/src" }]);
		expect((await broker.stillHeld()).map((tree) => tree.path)).toContain(
			"/trees/w-main/src",
		);
	});

	it("cuts a second tree for a different request", async () => {
		const { provider, cuts } = fakeProvider("git-worktree");
		const broker = createTreeBroker([provider]);

		await broker.ensure(snapshot("abc123"));
		await broker.ensure(snapshot("def456"));

		expect(cuts).toHaveLength(2);
	});

	it("stops reusing a tree once it is released", async () => {
		const { provider, cuts, released } = fakeProvider("git-worktree");
		const broker = createTreeBroker([provider]);

		const held = await broker.ensure(snapshot("abc123"));
		await broker.release(held);
		await broker.ensure(snapshot("abc123"));

		expect(released).toEqual(["/trees/git-worktree/1"]);
		expect(cuts).toHaveLength(2);
	});

	it("keeps a tree named when its release is cut off or refused, so a second one takes it", async () => {
		// A codemode script's time limit once stopped two World releases
		// while git was still at work, after the record was gone: both
		// trees stayed on disk with nothing able to name them (2AF2DH).
		const forgotten: string[] = [];
		const released: string[] = [];
		let refusals = 1;
		const provider: TreeProvider = {
			id: "git-worktree",
			specificity: 0,
			appliesTo: () => true,
			async ensure() {
				return { path: "/trees/one" };
			},
			async release(held) {
				if (refusals > 0) {
					refusals -= 1;
					throw new Error("The operation was aborted");
				}
				released.push(held.path);
			},
		};
		const held = await createTreeBroker([provider]).ensure(snapshot("abc123"));
		const broker = createTreeBroker({
			providers: [provider],
			memory: {
				...remembering(held, []),
				forget: (path) => {
					forgotten.push(path);
				},
				recall: () => (forgotten.includes(held.path) ? [] : [held]),
			},
		});
		const mine = await broker.ensure(snapshot("abc123"));

		await expect(broker.release(mine)).rejects.toThrow(/aborted/);
		expect(forgotten).toEqual([]);
		expect(broker.held().map((tree) => tree.path)).toEqual(["/trees/one"]);

		await broker.release(mine);
		expect(released).toEqual(["/trees/one"]);
		expect(forgotten).toEqual(["/trees/one"]);
		expect(broker.held()).toEqual([]);
	});

	it("sets a tree aside by the move it is given, never its provider, keeping it named while the move is refused", async () => {
		const { provider, released } = fakeProvider("git-worktree");
		const forgotten: string[] = [];
		const held = await createTreeBroker([provider]).ensure(snapshot("abc123"));
		const broker = createTreeBroker({
			providers: [provider],
			memory: {
				...remembering(held, []),
				whileHeldAlone: async (path, take) => {
					await take();
					forgotten.push(path);
					return 0;
				},
				recall: () => (forgotten.includes(held.path) ? [] : [held]),
			},
		});
		const mine = await broker.ensure(snapshot("abc123"));
		const moved: string[] = [];

		await expect(
			broker.setAside(mine, () => {
				throw new Error("EXDEV: cross-device link not permitted");
			}),
		).rejects.toThrow(/EXDEV/);
		expect(forgotten).toEqual([]);
		expect(broker.cutHere(mine.path), "still held here").toBe(true);

		const outcome = await broker.setAside(mine, (path) => {
			moved.push(path);
		});
		expect(outcome).toEqual({ kind: "released" });
		expect(moved).toEqual([mine.path]);
		expect(released).toEqual([]);
		expect(forgotten).toEqual([mine.path]);
		expect(broker.cutHere(mine.path)).toBe(false);
		expect(broker.held()).toEqual([]);
	});

	it("sets aside only its share of a tree another session holds, judged under the record's lock, moving nothing", async () => {
		const { provider } = fakeProvider("git-worktree");
		const held = await createTreeBroker([provider]).ensure(snapshot("abc123"));
		const broker = createTreeBroker({
			providers: [provider],
			memory: {
				...remembering(held, [4242]),
				// Asked outside the lock, a session joining before the move
				// would go unseen, so the memory alone may judge it.
				otherHolders: async () => {
					throw new Error("judged outside the record's lock");
				},
			},
		});
		const mine = await broker.ensure(snapshot("abc123"));
		const moved: string[] = [];

		const outcome = await broker.setAside(mine, (path) => {
			moved.push(path);
		});

		expect(outcome).toEqual({ kind: "released", kept: 1 });
		expect(moved).toEqual([]);
		expect(broker.cutHere(mine.path), "our share went").toBe(false);
	});

	it("lets go of a tree set aside though its record couldn't be forgotten", async () => {
		const { provider } = fakeProvider("git-worktree");
		const held = await createTreeBroker([provider]).ensure(snapshot("abc123"));
		const broker = createTreeBroker({
			providers: [provider],
			memory: {
				...remembering(held, []),
				whileHeldAlone: async (_path, take) => {
					await take();
					throw new Error("EACCES: permission denied");
				},
			},
		});
		const mine = await broker.ensure(snapshot("abc123"));

		await expect(broker.setAside(mine, () => {})).rejects.toThrow(/EACCES/);
		expect(broker.cutHere(mine.path), "moved, so not held here").toBe(false);
	});

	it("keeps a tree held when who else holds it can't be read", async () => {
		const { provider, released } = fakeProvider("git-worktree");
		const held = await createTreeBroker([provider]).ensure(snapshot("abc123"));
		const broker = createTreeBroker({
			providers: [provider],
			memory: {
				...remembering(held, []),
				otherHolders: async () => {
					throw new Error("EIO: i/o error");
				},
			},
		});
		const mine = await broker.ensure(snapshot("abc123"));

		await expect(broker.release(mine)).rejects.toThrow(/EIO/);
		expect(released).toEqual([]);
		expect(broker.cutHere(mine.path), "still held here").toBe(true);
	});

	it("reports what it is holding", async () => {
		const { provider } = fakeProvider("git-worktree");
		const broker = createTreeBroker([provider]);

		await broker.ensure(snapshot("abc123"));
		await broker.ensure(snapshot("def456"));

		expect(broker.held()).toHaveLength(2);
		expect(broker.held().map((tree) => tree.path)).toEqual([
			"/trees/git-worktree/1",
			"/trees/git-worktree/2",
		]);
	});

	it("refuses when no provider serves the repo", async () => {
		const { provider, cuts } = fakeProvider(
			"dev-tree",
			50,
			(repo) => repo.key === elsewhere.key,
		);
		const broker = createTreeBroker([provider]);

		await expect(broker.ensure(snapshot("abc123"))).rejects.toThrow(
			/no provider/i,
		);
		expect(cuts).toHaveLength(0);
	});

	it("names the repo it could not place when refusing", async () => {
		const broker = createTreeBroker([]);

		await expect(broker.ensure(snapshot("abc123"))).rejects.toThrow(
			/github:Shopify\/world/,
		);
	});

	it("refuses an ambiguous choice rather than cutting from either", async () => {
		// Two providers configured for one repo is a mistake, and
		// cutting from whichever registered first would hide it.
		const first = fakeProvider("dev-tree", 50);
		const second = fakeProvider("other-tree", 50);
		const broker = createTreeBroker([first.provider, second.provider]);

		await expect(broker.ensure(snapshot("abc123"))).rejects.toThrow(
			/dev-tree.*other-tree|other-tree.*dev-tree/,
		);
		expect(first.cuts).toHaveLength(0);
		expect(second.cuts).toHaveLength(0);
	});

	it("prefers the more specific provider", async () => {
		const general = fakeProvider("git-worktree");
		const special = fakeProvider("dev-tree", 50);
		const broker = createTreeBroker([general.provider, special.provider]);

		const held = await broker.ensure(snapshot("abc123"));

		expect(held.providerId).toBe("dev-tree");
		expect(general.cuts).toHaveLength(0);
	});

	it("releases through the provider that cut the tree", async () => {
		// The chosen provider can change between cutting and
		// releasing, as registration is dynamic. A tree has to go
		// back to whoever made it.
		const general = fakeProvider("git-worktree");
		const broker = createTreeBroker([general.provider]);
		const held = await broker.ensure(snapshot("abc123"));

		const special = fakeProvider("dev-tree", 50);
		const later = createTreeBroker([general.provider, special.provider]);
		await later.release(held);

		expect(general.released).toEqual(["/trees/git-worktree/1"]);
		expect(special.released).toEqual([]);
	});

	it("hands the caller's signal to the provider on a cut, a reuse and a release", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const provider: TreeProvider = {
			id: "git-worktree",
			specificity: 0,
			appliesTo: () => true,
			async ensure(_request, options) {
				signals.push(options?.signal);
				return { path: "/trees/one" };
			},
			async release(_held, options) {
				signals.push(options?.signal);
			},
		};
		const broker = createTreeBroker([provider]);
		const { signal } = new AbortController();

		const held = await broker.ensure(snapshot("abc123"), { signal });
		await broker.ensure(snapshot("abc123"), { signal });
		await broker.release(held, { signal });

		expect(signals).toEqual([signal, signal, signal]);
	});
});
