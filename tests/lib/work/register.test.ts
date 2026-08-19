import type { RepoLocator } from "@jitsusama/agentic-harness.core/review";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTreeBroker,
	type TreeProvider,
} from "../../../lib/work/broker.js";
import {
	clearTreeProviders,
	listTreeProviders,
	registerTreeProvider,
	unregisterTreeProvider,
} from "../../../lib/work/register.js";
import type { TreeRequest } from "../../../lib/work/tree.js";

const world: RepoLocator = { key: "github:Shopify/world" };
const request: TreeRequest = {
	intent: "snapshot",
	repo: world,
	purpose: "Shopify/world#42",
	commit: "abc123",
};

function stub(id: string, specificity = 0): TreeProvider {
	return {
		id,
		specificity,
		appliesTo: () => true,
		async ensure() {
			return { path: `/trees/${id}` };
		},
		async release() {},
	};
}

beforeEach(() => clearTreeProviders());
afterEach(() => clearTreeProviders());

describe("the tree provider registry", () => {
	it("starts empty", () => {
		expect(listTreeProviders()).toEqual([]);
	});

	it("holds what it is given", () => {
		registerTreeProvider(stub("git-worktree"));

		expect(listTreeProviders().map((p) => p.id)).toEqual(["git-worktree"]);
	});

	it("replaces rather than duplicates when an id registers twice", () => {
		// A provider re-registers on reload, and the host announces
		// itself again after one, so double registration is the
		// normal case rather than a mistake.
		registerTreeProvider(stub("dev-tree", 50));
		registerTreeProvider(stub("dev-tree", 70));

		const held = listTreeProviders();
		expect(held).toHaveLength(1);
		expect(held[0]?.specificity).toBe(70);
	});

	it("lists the most specific first, because consultation order is the contract", () => {
		registerTreeProvider(stub("git-worktree", 0));
		registerTreeProvider(stub("dev-tree", 50));

		expect(listTreeProviders().map((p) => p.id)).toEqual([
			"dev-tree",
			"git-worktree",
		]);
	});

	it("forgets a provider that unregisters", () => {
		registerTreeProvider(stub("dev-tree", 50));
		unregisterTreeProvider("dev-tree");

		expect(listTreeProviders()).toEqual([]);
	});

	it("ignores unregistering something it never had", () => {
		expect(() => unregisterTreeProvider("never-existed")).not.toThrow();
	});
});

describe("a broker over the registry", () => {
	it("consults a provider that registered after it was built", async () => {
		// Load order between extensions is not something either one
		// chooses, so a broker built first must still see a provider
		// that arrives later. Snapshotting the roster at
		// construction is the bug this guards.
		const broker = createTreeBroker(listTreeProviders);

		registerTreeProvider(stub("git-worktree"));
		const held = await broker.ensure(request);

		expect(held.providerId).toBe("git-worktree");
	});

	it("notices a provider that unregistered after it was built", async () => {
		const broker = createTreeBroker(listTreeProviders);
		registerTreeProvider(stub("git-worktree"));
		unregisterTreeProvider("git-worktree");

		await expect(broker.ensure(request)).rejects.toThrow(/no provider/i);
	});

	it("still accepts a fixed roster, for a caller that has one", async () => {
		const broker = createTreeBroker([stub("git-worktree")]);

		const held = await broker.ensure(request);

		expect(held.providerId).toBe("git-worktree");
	});

	it("prefers a more specific provider that registers later", async () => {
		const broker = createTreeBroker(listTreeProviders);
		registerTreeProvider(stub("git-worktree", 0));
		registerTreeProvider(stub("dev-tree", 50));

		const held = await broker.ensure(request);

		expect(held.providerId).toBe("dev-tree");
	});
});
