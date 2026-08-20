/**
 * Whether attaching a change says where its tree stands.
 *
 * The behaviour being pinned is a negative one, which is why it needs
 * a test at all: attaching must not cut a tree. A World tree costs
 * minutes and most readers only want the diff, so paying at attach
 * time bills everybody for what few of them need. What it must do
 * instead is say where things stand and name the call that would
 * change it, since a reader told only that no tree exists has to work
 * out which of nineteen actions makes one.
 */

import {
	type HeldTree,
	treeIdentity,
	WORK_READY,
} from "@jitsusama/agentic-harness.core/work";
import { describe, expect, it } from "vitest";
import {
	forgetWorkLayer,
	treeStandingFor,
	watchForWorkLayer,
} from "../../extensions/review-integration/work.js";

const REPO = { key: "github:acme/widgets", localPath: "/src/widgets" };
const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

/** Just enough of pi's bus to announce a working layer over. */
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

/**
 * A working layer holding exactly these trees.
 *
 * `ensure` throws rather than returning, so a test cannot pass by
 * cutting one: the whole claim is that nothing here provisions.
 */
function workLayerHolding(...held: HeldTree[]) {
	return {
		registerTreeProvider() {},
		listTreeProviders: () => [],
		broker: () => ({
			held: () => held,
			ensure() {
				throw new Error("nothing may cut a tree while reporting standing");
			},
			release() {
				throw new Error("not for this test");
			},
			cutHere: () => false,
		}),
	};
}

/** Announce a working layer to the module under test. */
function announce(layer: ReturnType<typeof workLayerHolding>): void {
	const pi = bus();
	watchForWorkLayer(pi as never);
	pi.events.emit(WORK_READY, layer);
}

describe("where a change's tree stands", () => {
	it("names the call that would cut one, when none is", async () => {
		forgetWorkLayer();
		announce(workLayerHolding());

		const standing = await treeStandingFor(REPO, COMMIT);

		expect(standing.kind).toBe("none");
		// The call itself, not a description of it.
		expect(standing.kind === "none" && standing.would).toContain(
			"work snapshot",
		);
		expect(standing.kind === "none" && standing.would).toContain(REPO.key);
		// The whole commit, because this is a command rather than a
		// description of one. It used to be abbreviated for reading, and
		// running what it said then failed: a fetch of an unmerged head
		// answers `couldn't find remote ref d99232b14cb8`, which reads as
		// a commit that does not exist rather than one named too short.
		expect(standing.kind === "none" && standing.would).toContain(COMMIT);
	});

	it("reports the tree already cut for that commit", async () => {
		forgetWorkLayer();
		const request = {
			intent: "snapshot",
			repo: REPO,
			purpose: "review",
			commit: COMMIT,
		} as const;
		announce(
			workLayerHolding({
				identity: treeIdentity(request),
				path: "/src/widgets/.worktrees/snap",
				providerId: "git-worktree",
			}),
		);

		expect(await treeStandingFor(REPO, COMMIT)).toEqual({
			kind: "cut",
			path: "/src/widgets/.worktrees/snap",
		});
	});

	it("does not mistake another commit's tree for this one's", async () => {
		forgetWorkLayer();
		announce(
			workLayerHolding({
				identity: treeIdentity({
					intent: "snapshot",
					repo: REPO,
					purpose: "review",
					commit: "9999999999999999999999999999999999999999",
				}),
				path: "/src/widgets/.worktrees/other",
				providerId: "git-worktree",
			}),
		);

		expect((await treeStandingFor(REPO, COMMIT)).kind).toBe("none");
	});

	it("says it cannot tell, rather than guessing, with no working layer", async () => {
		forgetWorkLayer();

		const standing = await treeStandingFor(REPO, COMMIT);

		expect(standing.kind).toBe("unknown");
		expect(standing.kind === "unknown" && standing.why).toContain(
			"no working layer",
		);
	});

	it("says it cannot tell when the provider reports no commit", async () => {
		forgetWorkLayer();
		announce(workLayerHolding());

		const standing = await treeStandingFor(REPO, undefined);

		expect(standing.kind).toBe("unknown");
		expect(standing.kind === "unknown" && standing.why).toContain("commit");
	});
});
