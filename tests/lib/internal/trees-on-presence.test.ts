/**
 * A peer's presence names the trees its session holds, as the work
 * broker's records say, so mycelium draws a tree two cells hold as a
 * network of its own (mycelium #208). A repository with no origin is
 * named by its main checkout, never by each worktree's folder.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../lib/mesh/peer.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { repositoryName } from "../../../lib/mesh/scope.ts";

let root: string;
const session = "01a1e0aa-0000-7000-8000-000000000262";
const other = "01a1e0aa-0000-7000-8000-000000000999";
const SHA = "0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-trees-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A main checkout at `name`, with `origin` when given. */
function mainCheckout(name: string, origin?: string): string {
	const at = join(root, name);
	mkdirSync(join(at, ".git", "worktrees"), { recursive: true });
	const remote = origin ? `[remote "origin"]\n\turl = ${origin}\n` : "";
	writeFileSync(
		join(at, ".git", "config"),
		`[core]\n\tbare = false\n${remote}`,
	);
	writeFileSync(join(at, ".git", "HEAD"), "ref: refs/heads/main\n");
	return at;
}

/** A worktree of `main` named `key`, its HEAD reading `head`. */
function worktree(main: string, key: string, head: string): string {
	const own = join(main, ".git", "worktrees", key);
	mkdirSync(own, { recursive: true });
	writeFileSync(join(own, "HEAD"), `${head}\n`);
	writeFileSync(join(own, "commondir"), "../..\n");
	const at = join(root, "trees", key);
	mkdirSync(at, { recursive: true });
	writeFileSync(join(at, ".git"), `gitdir: ${own}\n`);
	return at;
}

/** The broker's record of the tree at `path`, held by `sessions`. */
function record(path: string, sessions: readonly string[]): void {
	const key = path.split("/").pop() ?? path;
	mkdirSync(join(root, "cut"), { recursive: true });
	writeFileSync(
		join(root, "cut", `${key}.json`),
		JSON.stringify({
			identity: { key, shareable: false },
			path,
			providerId: "git-worktree",
			owners: [],
			sessions,
		}),
	);
}

/** A peer whose records name the broker's records folder. */
function peerWithTrees() {
	const presences = createPresences(join(root, "presence"));
	const peer = localPeer({
		session,
		cwd: root,
		records: {
			sessions: join(root, "sessions"),
			quests: join(root, "quests"),
			trees: join(root, "cut"),
		},
		presences,
	});
	return { peer, presences };
}

describe("a peer's trees", () => {
	it("name each tree it holds by key, repository and branch or commit", () => {
		const harness = mainCheckout(
			"harness",
			"https://github.com/Jitsusama/agentic-harness.pi.git",
		);
		const local = mainCheckout("acceluary");
		record(worktree(harness, "w-feature", "ref: refs/heads/jitsusama/x"), [
			session,
		]);
		record(worktree(local, "s-pinned", SHA), [session, other]);
		const { presences, peer } = peerWithTrees();

		expect(presences.of(session)?.trees, "both trees, by key").toEqual([
			{ key: "s-pinned", repo: "local:acceluary", commit: SHA },
			{
				key: "w-feature",
				repo: "github:Jitsusama/agentic-harness.pi",
				branch: "jitsusama/x",
			},
		]);
		peer.dispose();
	});

	it("leave out a tree only another session holds, and say none at all", () => {
		const harness = mainCheckout("harness");
		record(worktree(harness, "w-theirs", "ref: refs/heads/theirs"), [other]);
		const { presences, peer } = peerWithTrees();

		expect(presences.of(session)?.trees, "none of its own").toBeUndefined();
		peer.dispose();
	});

	it("are read again once a record changes", () => {
		const harness = mainCheckout("harness");
		const { presences, peer } = peerWithTrees();
		expect(presences.of(session)?.trees, "none yet").toBeUndefined();

		record(worktree(harness, "w-later", "ref: refs/heads/later"), [session]);
		peer.refresh();

		expect(presences.of(session)?.trees, "the new tree").toEqual([
			{ key: "w-later", repo: "local:harness", branch: "later" },
		]);
		peer.dispose();
	});

	it("are dropped by a reader when malformed", () => {
		const { presences, peer } = peerWithTrees();
		const own = presences.of(session);
		if (own === undefined) throw new Error("the peer published nothing");
		const file = join(root, "presence", `${session}.json`);
		const good = { key: "w", repo: "local:a", branch: "b" };
		writeFileSync(
			file,
			JSON.stringify({ ...own, trees: [good, { key: 7 }, { key: "x" }] }),
		);

		expect(presences.of(session)?.trees, "only the readable one").toEqual([
			good,
		]);
		peer.dispose();
	});
});

describe("a repository with no origin", () => {
	it("is named by its main checkout, whichever worktree is asked", () => {
		const local = mainCheckout("acceluary");
		const tree = worktree(local, "worktree-local-acceluary-x", SHA);

		expect(repositoryName(tree)).toBe("acceluary");
		expect(repositoryName(local)).toBe("acceluary");
	});
});
