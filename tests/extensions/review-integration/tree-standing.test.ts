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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	forgetWorkLayer,
	treeStandingFor,
	watchForWorkLayer,
} from "../../../extensions/review-integration/work.ts";
import {
	type HeldTree,
	treeIdentity,
	WORK_READY,
} from "../../../lib/core/work/index.ts";

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
 * cutting one: the whole claim is that nothing here provisions. What
 * `used` was told is kept in `dated`, and those in `taken` answer as
 * gone, as a tree a sweep took meanwhile does. While `refused` is set,
 * dating throws, as a held lock or a full disk makes it.
 */
function workLayerHolding(...held: HeldTree[]) {
	const dated: string[] = [];
	const taken = new Set<string>();
	const layer = {
		dated,
		taken,
		refused: false,
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
			used(tree: HeldTree) {
				if (layer.refused) {
					return Promise.reject(new Error("the record's lock is held"));
				}
				dated.push(tree.path);
				return Promise.resolve(!taken.has(tree.path));
			},
		}),
	};
	return layer;
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

	// A reader sent to a snapshot by path leaves no sign a sweep can
	// see, and one last asked for nearly four hours ago was taken while
	// a review read it, so naming it dates it as an ask would.
	it("dates the use of the tree it names", async () => {
		forgetWorkLayer();
		const layer = workLayerHolding({
			identity: treeIdentity({
				intent: "snapshot",
				repo: REPO,
				purpose: "review",
				commit: COMMIT,
			}),
			path: "/src/widgets/.worktrees/snap",
			providerId: "git-worktree",
		});
		announce(layer);

		await treeStandingFor(REPO, COMMIT);

		expect(layer.dated, "naming a tree didn't date its use").toEqual([
			"/src/widgets/.worktrees/snap",
		]);
	});

	it("names the call that cuts one, when a sweep took the tree meanwhile", async () => {
		forgetWorkLayer();
		const layer = workLayerHolding({
			identity: treeIdentity({
				intent: "snapshot",
				repo: REPO,
				purpose: "review",
				commit: COMMIT,
			}),
			path: "/src/widgets/.worktrees/snap",
			providerId: "git-worktree",
		});
		layer.taken.add("/src/widgets/.worktrees/snap");
		announce(layer);

		const standing = await treeStandingFor(REPO, COMMIT);

		expect(standing.kind).toBe("none");
	});

	// The change is attached by the time its tree's use is dated, so a
	// lock that can't be got or a full disk must not fail the attach.
	// Nor may it name the tree: a lock held that long is most likely a
	// sweep taking it, and an undated use gives the sweep nothing to
	// keep it by.
	it("names the call that cuts one when its use can't be dated", async () => {
		forgetWorkLayer();
		const folder = mkdtempSync(join(tmpdir(), "tree-standing-"));
		try {
			const layer = workLayerHolding({
				identity: treeIdentity({
					intent: "snapshot",
					repo: REPO,
					purpose: "review",
					commit: COMMIT,
				}),
				path: folder,
				providerId: "git-worktree",
			});
			layer.refused = true;
			announce(layer);

			const standing = await treeStandingFor(REPO, COMMIT);

			expect(
				standing.kind,
				"a standing tree whose use couldn't be dated was named",
			).toBe("none");
			expect(standing.kind === "none" && standing.would).toContain(COMMIT);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
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
