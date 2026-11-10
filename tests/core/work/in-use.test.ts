// Which recorded trees something still works in, whatever their owners say.
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { treesInUse, treesToKeep } from "../../../lib/core/work/in-use.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "in-use-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A recorded tree at `name` under the test's folder, held by `sessions`. */
function recorded(name: string, sessions?: string[]): HeldTree {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	return {
		identity: { key: name, shareable: true },
		path,
		providerId: "git-worktree",
		// Its process ended: the session, if any, runs in another now.
		owners: [{ pid: 999_999, startedAt: 1 }],
		...(sessions !== undefined ? { sessions } : {}),
	};
}

/** Make a tree's git folder look used at `at`. */
function gitUsedAt(tree: HeldTree, at: number): void {
	const git = join(tree.path, ".git");
	mkdirSync(git, { recursive: true });
	writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
	utimesSync(join(git, "HEAD"), at / 1000, at / 1000);
}

const paths = (trees: readonly HeldTree[]) => trees.map((tree) => tree.path);

describe("which recorded trees are still in use", () => {
	it("names a tree a session still running holds, though the process its record names ended", async () => {
		// 10 November: reclaim would have taken 59 snapshots that two
		// sessions, resumed in new processes, still named (E000B57C).
		const resumed = recorded("resumed", ["01a1bdf4"]);
		const ended = recorded("ended", ["01a1aaaa"]);

		expect(
			paths(
				await treesInUse({ liveSessions: async () => new Set(["01a1bdf4"]) }, [
					resumed,
					ended,
				]),
			),
		).toEqual([resumed.path]);
	});

	it("names a tree a running process stands in, or below", async () => {
		const stoodIn = recorded("stood-in", ["gone"]);
		const left = recorded("left", ["gone"]);
		// A process's working folder exists, as the kernel names it.
		mkdirSync(join(stoodIn.path, "lib"));

		expect(
			paths(
				await treesInUse({ standingIn: () => [join(stoodIn.path, "lib")] }, [
					stoodIn,
					left,
				]),
			),
		).toEqual([stoodIn.path]);
	});

	it("names a tree no session is recorded for once its git moved this boot", async () => {
		const booted = Date.now() - 60_000;
		const movedSince = recorded("moved-since");
		const stillSince = recorded("still-since");
		gitUsedAt(movedSince, Date.now());
		gitUsedAt(stillSince, booted - 60_000);

		expect(
			paths(await treesInUse({ bootedAt: booted }, [movedSince, stillSince])),
		).toEqual([movedSince.path]);
	});

	it("names nothing when nothing tells of use", async () => {
		expect(await treesInUse({}, [recorded("idle", ["gone"])])).toEqual([]);
	});
});

describe("the trees a survey keeps", () => {
	/** A broker whose records are `all`, of which only `running` have a running owner. */
	function broker(
		all: HeldTree[],
		running: HeldTree[] = [],
		unattributed: HeldTree[] = [],
	) {
		return {
			held: () => all,
			stillHeld: async () => [...running, ...unattributed],
			unattributed: () => unattributed,
		};
	}

	it("keeps a tree a resumed session still holds, beside those a running owner holds", async () => {
		const resumed = recorded("resumed", ["01a1be42"]);
		const owned = recorded("owned", ["01a1cccc"]);
		const spent = recorded("spent", ["01a1aaaa"]);

		expect(
			await treesToKeep(broker([resumed, owned, spent], [owned]), {
				liveSessions: async () => new Set(["01a1be42", "01a1cccc"]),
			}),
		).toEqual([owned.path, resumed.path]);
	});

	it("leaves out a tree no record attributes, which is kept and said apart", async () => {
		const nobody = recorded("nobody");
		gitUsedAt(nobody, Date.now());

		expect(
			await treesToKeep(broker([nobody], [], [nobody]), {
				bootedAt: Date.now() - 60_000,
			}),
		).toEqual([]);
	});
});
