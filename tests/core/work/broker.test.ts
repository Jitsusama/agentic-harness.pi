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
		forgetUsAsHolder: async () => {},
		whileUnheld: async () => undefined,
		holdWhileUnheld: async () => undefined,
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
