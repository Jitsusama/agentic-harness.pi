import { describe, expect, it } from "vitest";
import {
	isWorktreeProvider,
	type WorktreeHandle,
	type WorktreeProvider,
	WorktreeProviderBroker,
	WorktreeRegistry,
	type WorktreeRequest,
} from "../../../extensions/pr-workflow/worktree.js";

/**
 * The WorktreeRegistry coordinates handle lifecycle across
 * a session: it asks the configured provider to ensure a
 * worktree exists, tracks the resulting handle so it can
 * be released on session close, and reuses an existing
 * handle when the same repo+sha is requested twice.
 *
 * The provider interface is what callers plug into.
 * These tests inject an in-memory fake provider so they
 * focus on the registry's coordination, not git plumbing.
 */

function fakeProvider(): WorktreeProvider & {
	readonly ensured: WorktreeRequest[];
	readonly released: WorktreeHandle[];
} {
	const ensured: WorktreeRequest[] = [];
	const released: WorktreeHandle[] = [];
	let counter = 0;
	return {
		id: "fake",
		async ensure(req) {
			ensured.push(req);
			counter++;
			return {
				path: `/tmp/wt/${req.owner}/${req.repo}/${req.sha}`,
				sha: req.sha,
				providerId: "fake",
				createdAt: new Date(0),
				reusable: true,
				marker: `wt-${counter}`,
			};
		},
		async release(handle) {
			released.push(handle);
		},
		ensured,
		released,
	};
}

const REQ: WorktreeRequest = {
	owner: "octocat",
	repo: "hello-world",
	sha: "abc123",
};

describe("WorktreeProviderBroker", () => {
	it("uses the highest-priority provider that can handle the request", async () => {
		const fallback = fakeProvider();
		const world = fakeProvider();
		const broker = new WorktreeProviderBroker(fallback);
		broker.register({
			...world,
			id: "world",
			priority: 100,
			canHandle: (req) => req.owner === "shop" && req.repo === "world",
		});

		const handle = await broker.ensure({
			owner: "shop",
			repo: "world",
			sha: "abc123",
		});

		expect(handle.providerId).toBe("fake");
		expect(world.ensured).toHaveLength(1);
		expect(fallback.ensured).toHaveLength(0);
	});

	it("falls back when registered providers decline the request", async () => {
		const fallback = fakeProvider();
		const custom = fakeProvider();
		const broker = new WorktreeProviderBroker(fallback);
		broker.register({
			...custom,
			id: "world",
			priority: 100,
			canHandle: () => false,
		});

		await broker.ensure(REQ);

		expect(custom.ensured).toHaveLength(0);
		expect(fallback.ensured).toEqual([REQ]);
	});

	it("replaces providers with the same id", async () => {
		const fallback = fakeProvider();
		const first = fakeProvider();
		const second = fakeProvider();
		const broker = new WorktreeProviderBroker(fallback);
		broker.register({ ...first, id: "custom", canHandle: () => true });
		broker.register({ ...second, id: "custom", canHandle: () => true });

		await broker.ensure(REQ);

		expect(first.ensured).toHaveLength(0);
		expect(second.ensured).toEqual([REQ]);
		expect(broker.providerIds()).toEqual(["custom", "fake"]);
	});

	it("routes release to the provider that owns the handle", async () => {
		const fallback = fakeProvider();
		const custom = fakeProvider();
		const broker = new WorktreeProviderBroker(fallback);
		broker.register({ ...custom, id: "custom", canHandle: () => true });
		const handle = await broker.ensure(REQ);
		const owned = { ...handle, providerId: "custom" };

		await broker.release(owned);

		expect(custom.released).toEqual([owned]);
		expect(fallback.released).toHaveLength(0);
	});
});

describe("isWorktreeProvider", () => {
	it("accepts structurally-valid event-bus providers", () => {
		expect(isWorktreeProvider(fakeProvider())).toBe(true);
	});

	it("rejects invalid event-bus provider payloads", () => {
		expect(isWorktreeProvider(null)).toBe(false);
		expect(
			isWorktreeProvider({ id: "bad", ensure: async () => undefined }),
		).toBe(false);
	});
});

describe("WorktreeRegistry", () => {
	it("delegates ensure() to the provider and returns the handle", async () => {
		// Round-trip: the registry doesn't transform handles,
		// it just routes them through. Callers receive what
		// the provider produced.
		const provider = fakeProvider();
		const registry = new WorktreeRegistry(provider);
		const handle = await registry.ensure(REQ);
		expect(handle.providerId).toBe("fake");
		expect(handle.sha).toBe("abc123");
		expect(handle.path).toContain("hello-world");
		expect(provider.ensured).toEqual([REQ]);
	});

	it("reuses a single handle when the same repo+sha is requested twice", async () => {
		// Two reviewers in the same council both ask for
		// the same PR head SHA. The provider only sees one
		// ensure() call; both reviewers get the same path.
		const provider = fakeProvider();
		const registry = new WorktreeRegistry(provider);
		const h1 = await registry.ensure(REQ);
		const h2 = await registry.ensure(REQ);
		expect(h1).toBe(h2);
		expect(provider.ensured).toHaveLength(1);
	});

	it("scopes reuse by repo+sha tuple, not by either alone", async () => {
		// Different SHA in the same repo, or same SHA in a
		// different repo, are different worktrees. The
		// registry must NOT collapse those.
		const provider = fakeProvider();
		const registry = new WorktreeRegistry(provider);
		const a = await registry.ensure(REQ);
		const b = await registry.ensure({ ...REQ, sha: "def456" });
		const c = await registry.ensure({ ...REQ, repo: "other" });
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
		expect(b).not.toBe(c);
		expect(provider.ensured).toHaveLength(3);
	});

	it("releases every tracked handle on releaseAll()", async () => {
		// Session close path: every worktree the registry
		// allocated must be offered to the provider for
		// cleanup. The provider decides what to actually
		// do (delete, leave, etc.).
		const provider = fakeProvider();
		const registry = new WorktreeRegistry(provider);
		const a = await registry.ensure(REQ);
		const b = await registry.ensure({ ...REQ, sha: "def456" });
		await registry.releaseAll();
		expect(provider.released).toHaveLength(2);
		expect(provider.released).toContain(a);
		expect(provider.released).toContain(b);
	});

	it("clears tracking after releaseAll() so a new ensure() goes back to the provider", async () => {
		// Post-cleanup, the registry must not still consider
		// a released handle "active". Re-requesting the same
		// repo+sha after release must round-trip the provider
		// again rather than returning a stale handle.
		const provider = fakeProvider();
		const registry = new WorktreeRegistry(provider);
		await registry.ensure(REQ);
		await registry.releaseAll();
		await registry.ensure(REQ);
		expect(provider.ensured).toHaveLength(2);
	});

	it("releaseAll() continues releasing remaining handles when one provider release throws", async () => {
		// Partial failure must not strand other worktrees.
		// If git worktree remove fails for handle A, the
		// registry still attempts B. Errors are collected
		// and re-thrown as an aggregate so the caller can
		// see what failed.
		let calls = 0;
		const released: WorktreeHandle[] = [];
		const provider: WorktreeProvider = {
			id: "flaky",
			async ensure(req) {
				calls++;
				return {
					path: `/tmp/wt/${calls}`,
					sha: req.sha,
					providerId: "flaky",
					createdAt: new Date(0),
					reusable: true,
				};
			},
			async release(handle) {
				if (handle.path === "/tmp/wt/1") {
					throw new Error("git worktree remove failed");
				}
				released.push(handle);
			},
		};
		const registry = new WorktreeRegistry(provider);
		await registry.ensure(REQ);
		await registry.ensure({ ...REQ, sha: "def456" });
		await expect(registry.releaseAll()).rejects.toThrow(
			/git worktree remove failed/,
		);
		// The second handle was still released despite the
		// first one throwing.
		expect(released).toHaveLength(1);
	});

	it("exposes the active set so callers can inspect what's allocated", async () => {
		// Diagnostics and UI surfaces want to know which
		// worktrees the session currently holds open.
		const provider = fakeProvider();
		const registry = new WorktreeRegistry(provider);
		const a = await registry.ensure(REQ);
		const b = await registry.ensure({ ...REQ, sha: "def456" });
		const active = registry.active();
		expect(active).toHaveLength(2);
		expect(active).toContain(a);
		expect(active).toContain(b);
	});
});
