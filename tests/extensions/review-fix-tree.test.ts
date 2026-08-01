/**
 * Being handed somewhere to work along with the next thing to fix.
 *
 * The rule this pins is where eager provisioning is right and where
 * it is not. Attaching a change stays lazy, because reading wants a
 * diff and a tree costs minutes. Being handed the next item is the
 * opposite: there is no cheaper substitute for a working directory,
 * and telling somebody what to fix while leaving them to find
 * somewhere to fix it is the last mile nobody walks.
 */

import { describe, expect, it } from "vitest";
import {
	forgetWorkLayer,
	treeForFixing,
	watchForWorkLayer,
} from "../../extensions/review-integration/work.js";
import {
	type HeldTree,
	type TreeRequest,
	treeIdentity,
	WORK_READY,
} from "../../lib/work/index.js";

const REPO = { key: "github:acme/widgets", localPath: "/src/widgets" };

function bus() {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	return {
		events: {
			on(name: string, fn: (data: unknown) => void) {
				listeners.set(name, [...(listeners.get(name) ?? []), fn]);
			},
			emit(name: string, data: unknown) {
				for (const fn of listeners.get(name) ?? []) fn(data);
			},
		},
	};
}

/** A working layer that records what it was asked to cut. */
function recordingLayer() {
	const cut: TreeRequest[] = [];
	const held: HeldTree[] = [];
	const layer = {
		registerTreeProvider() {},
		listTreeProviders: () => [],
		broker: () => ({
			held: () => held,
			async ensure(request: TreeRequest) {
				const identity = treeIdentity(request);
				const already = held.find((one) => one.identity.key === identity.key);
				if (already) return already;
				cut.push(request);
				const fresh: HeldTree = {
					identity,
					path: `/src/widgets/.worktrees/${identity.key}`,
					providerId: "git-worktree",
				};
				held.push(fresh);
				return fresh;
			},
			release() {
				throw new Error("not for this test");
			},
			cutHere: () => true,
		}),
	};
	return { layer, cut };
}

function announce(layer: unknown): void {
	const pi = bus();
	watchForWorkLayer(pi as never);
	pi.events.emit(WORK_READY, layer);
}

describe("somewhere to fix the next item", () => {
	it("cuts a worktree at the change's head branch", async () => {
		forgetWorkLayer();
		const { layer, cut } = recordingLayer();
		announce(layer);

		const where = await treeForFixing(REPO, "fix-the-thing");

		expect(where).toEqual({
			path: "/src/widgets/.worktrees/worktree-github-acme-widgets-fix-the-thing",
		});
		// A worktree, not a snapshot: this one gets committed in.
		expect(cut).toHaveLength(1);
		expect(cut[0]?.intent).toBe("worktree");
		expect(cut[0]?.intent === "worktree" && cut[0].branch).toBe(
			"fix-the-thing",
		);
	});

	it("hands the same tree to every item on the change", async () => {
		forgetWorkLayer();
		const { layer, cut } = recordingLayer();
		announce(layer);

		const first = await treeForFixing(REPO, "fix-the-thing");
		const second = await treeForFixing(REPO, "fix-the-thing");

		expect(second).toEqual(first);
		// The point: a second finding must not cost a second tree. You
		// fix them all on the one branch, and the broker's identity rule
		// already says so.
		expect(cut).toHaveLength(1);
	});

	it("still hands over the item when there is nowhere to work", async () => {
		forgetWorkLayer();

		const where = await treeForFixing(REPO, "fix-the-thing");

		// A refusal rather than a throw. Somebody who knows what to fix
		// and must find their own directory is inconvenienced; somebody
		// shown an error instead of the item has lost what they asked for.
		expect("refusal" in where).toBe(true);
		expect("refusal" in where && where.refusal).toContain("working layer");
	});
});
