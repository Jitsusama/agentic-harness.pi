import { describe, expect, it } from "vitest";
import {
	ancestorTreesOf,
	describeCwdSource,
	pickResumeSession,
	reopenedCwd,
	reopenedSession,
	resolveSpawnCwd,
	summariseSessions,
} from "../../../../lib/internal/quest/reopen.ts";
import type { SessionView } from "../../../../lib/internal/quest/session-liveness.ts";
import type { QuestTree } from "../../../../lib/quest/types.ts";

function tree(path: string, repoRoot?: string): QuestTree {
	return { path, repoRoot, providerId: "git-worktree" };
}

function liveSession(cwd: string, lastActivity: string): SessionView {
	return { id: cwd, cwd, status: "active", liveness: "live", lastActivity };
}

const all = () => true;
const none = () => false;
const onlyAt =
	(...present: string[]) =>
	(p: string) =>
		present.includes(p);

describe("resolveSpawnCwd", () => {
	it("prefers an existing tree path", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [tree("/work/tree")],
			sessions: [],
			exists: all,
		});
		expect(result).toEqual({ cwd: "/work/tree", source: "tree" });
	});

	it("prefers the newest tree when several exist", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [tree("/old"), tree("/new")],
			sessions: [],
			exists: all,
		});
		expect(result.cwd).toBe("/new");
	});

	it("falls back to a live session cwd and flags the heal", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [tree("/gone")],
			sessions: [liveSession("/sess/cwd", "2026-06-04T10:00:00.000Z")],
			exists: onlyAt("/sess/cwd", "/q"),
		});
		expect(result).toEqual({
			cwd: "/sess/cwd",
			source: "session",
			healed: true,
		});
	});

	it("uses the most-recent session cwd", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [],
			sessions: [
				liveSession("/older", "2026-06-04T09:00:00.000Z"),
				liveSession("/newer", "2026-06-04T11:00:00.000Z"),
			],
			exists: all,
		});
		expect(result.cwd).toBe("/newer");
	});

	it("falls back to a tree repoRoot before the quest dir", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [tree("/gone", "/repo/root")],
			sessions: [],
			exists: onlyAt("/repo/root", "/q"),
		});
		expect(result).toEqual({
			cwd: "/repo/root",
			source: "repoRoot",
			healed: true,
		});
	});

	// A session started in a quest's folder loads no repo's AGENTS.md or
	// skills, so the folder is never where one is opened.
	it("falls back to home, never the quest dir, when nothing else resolves", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			home: "/home/joel",
			trees: [],
			sessions: [],
			exists: none,
		});
		expect(result).toEqual({ cwd: "/home/joel", source: "home" });
	});

	it("flags the heal when a recorded path was missing and it falls through to home", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			home: "/home/joel",
			// A recorded tree path that no longer exists: resolution
			// heals past it, and nothing else resolves, so it lands on
			// home but must still report that a stale record was met.
			trees: [{ path: "/gone", providerId: "git-worktree" }],
			sessions: [],
			exists: none,
		});
		expect(result).toEqual({
			cwd: "/home/joel",
			source: "home",
			healed: true,
		});
	});

	it("skips a session that ran in a folder of the quest store", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-1",
			store: "/store",
			home: "/home/joel",
			trees: [tree("/gone", "/src/repo")],
			sessions: [
				liveSession("/store/QEST-1", "2026-10-25T18:00:00Z"),
				liveSession("/store/QEST-2/plans", "2026-10-25T17:00:00Z"),
			],
			exists: onlyAt("/store/QEST-1", "/store/QEST-2/plans", "/src/repo"),
		});
		expect(result).toEqual({
			cwd: "/src/repo",
			source: "repoRoot",
			healed: true,
		});
	});

	// A builder subquest starts with no tree and no session of its own, and
	// on 2026-11-03 seventeen opened in home that way, loading no repo's
	// AGENTS.md: the repo its parent works in is the next best place.
	it("opens a quest with nothing of its own in its parent's newest repo", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [
				[tree("/parent/old", "/src/old"), tree("/parent/new", "/src/repo")],
			],
			exists: all,
			checkoutOf: (dir) => dir,
		});
		expect(result).toEqual({ cwd: "/src/repo", source: "ancestorRepoRoot" });
	});

	// A parent's worktree is its own: a builder opened in it would edit the
	// parent's files. An adopted tree records itself as its repoRoot, so the
	// repo is the checkout the worktree was cut from.
	it("never opens in a parent's tree, even one recorded as its own repo", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [[tree("/trees/parent", "/trees/parent")]],
			exists: all,
			checkoutOf: (dir) => (dir === "/trees/parent" ? "/src/core" : dir),
		});
		expect(result).toEqual({ cwd: "/src/core", source: "ancestorRepoRoot" });
	});

	it("goes home rather than into a parent's tree whose checkout is unknown", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [
				[tree("/trees/parent", "/trees/parent")],
				[tree("/trees/gp")],
			],
			spawner: "/trees/parent/lib",
			exists: all,
			checkoutOf: (dir) => (dir.startsWith("/trees/") ? undefined : dir),
		});
		expect(result).toEqual({ cwd: "/home/joel", source: "home" });
	});

	it("passes over a checkout that is itself a parent's adopted tree", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [[tree("/src/core", "/src/core")]],
			exists: all,
			checkoutOf: (dir) => dir,
		});
		expect(result).toEqual({ cwd: "/home/joel", source: "home" });
	});

	it("takes a parent's repo when its trees are gone", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [[tree("/parent/gone", "/src/repo")]],
			exists: onlyAt("/src/repo"),
		});
		// A parent's missing tree is not this quest's record to heal.
		expect(result).toEqual({ cwd: "/src/repo", source: "ancestorRepoRoot" });
	});

	it("prefers the nearest ancestor that has somewhere to work", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-3",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [[], [tree("/grandparent/tree")]],
			exists: all,
			checkoutOf: (dir) =>
				dir === "/grandparent/tree" ? "/src/grandparent" : dir,
		});
		expect(result).toEqual({
			cwd: "/src/grandparent",
			source: "ancestorRepoRoot",
		});
	});

	it("keeps the quest's own repo ahead of its parent's tree", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [tree("/gone", "/own/repo")],
			sessions: [],
			ancestors: [[tree("/parent/tree")]],
			exists: onlyAt("/own/repo", "/parent/tree"),
		});
		expect(result.cwd).toBe("/own/repo");
	});

	it("opens in the spawning session's repo when no quest has anywhere", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			ancestors: [[]],
			spawner: "/src/repo/lib",
			exists: onlyAt("/src/repo/lib", "/src/repo/.git"),
		});
		expect(result).toEqual({ cwd: "/src/repo/lib", source: "spawner" });
	});

	// The spawner's worktree belongs to the spawner's quest, not the new one.
	it("opens in the checkout a spawning session's worktree was cut from", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			spawner: "/trees/spawner/lib",
			exists: onlyAt("/trees/spawner/lib", "/trees/spawner/.git", "/src/repo"),
			checkoutOf: (dir) => (dir === "/trees/spawner" ? "/src/repo" : dir),
		});
		expect(result).toEqual({ cwd: "/src/repo", source: "spawner" });
	});

	it("passes over a spawning session that is not in a repo", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			home: "/home/joel",
			trees: [],
			sessions: [],
			spawner: "/home/joel/notes",
			exists: onlyAt("/home/joel/notes"),
		});
		expect(result).toEqual({ cwd: "/home/joel", source: "home" });
	});

	it("never opens in the quest store, even where the spawner sits in it", () => {
		const result = resolveSpawnCwd({
			questDir: "/store/QEST-2",
			store: "/store",
			home: "/home/joel",
			trees: [],
			sessions: [],
			spawner: "/store/QEST-1",
			// The store is itself a git repository on some machines.
			exists: all,
		});
		expect(result).toEqual({ cwd: "/home/joel", source: "home" });
	});

	it("skips the quest dir itself even with no store named", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			home: "/home/joel",
			trees: [],
			sessions: [liveSession("/q", "2026-10-25T18:00:00Z")],
			exists: all,
		});
		expect(result).toEqual({ cwd: "/home/joel", source: "home" });
	});
});

describe("ancestorTreesOf", () => {
	it("lists each ancestor's trees, nearest first, and stops at a cycle", () => {
		const quests: Record<string, { trees?: QuestTree[]; parent?: string }> = {
			P: { trees: [tree("/p")], parent: "G" },
			G: { parent: "P" },
		};
		expect(ancestorTreesOf("P", (id) => quests[id])).toEqual([
			[tree("/p")],
			[],
		]);
	});

	it("is empty for a quest with no parent", () => {
		expect(ancestorTreesOf(undefined, () => undefined)).toEqual([]);
	});
});

describe("describeCwdSource", () => {
	it("says where a parent's repo chose the folder", () => {
		expect(describeCwdSource("ancestorRepoRoot")).toBe("a parent quest's repo");
	});
});

function view(
	id: string,
	liveness: SessionView["liveness"],
	lastActivity?: string,
): SessionView {
	return { id, status: "active", liveness, lastActivity };
}

describe("pickResumeSession", () => {
	it("returns undefined only when every session is dead or detached", () => {
		expect(
			pickResumeSession([view("a", "dead"), view("b", "detached")]),
		).toBeUndefined();
	});

	it("returns undefined for an empty session list", () => {
		expect(pickResumeSession([])).toBeUndefined();
	});

	it("returns the single live session", () => {
		expect(pickResumeSession([view("a", "idle"), view("b", "live")])).toEqual({
			id: "b",
		});
	});

	it("returns an ambiguous list, most-recent first, when several are live", () => {
		const result = pickResumeSession([
			view("older", "live", "2026-06-04T09:00:00.000Z"),
			view("newer", "live", "2026-06-04T11:00:00.000Z"),
		]);
		expect(result).toHaveProperty("ambiguous");
		if (!result || !("ambiguous" in result))
			throw new Error("expected ambiguous");
		expect(result.ambiguous.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("falls back to the most-recent idle session when none is live", () => {
		expect(
			pickResumeSession([
				view("older", "idle", "2026-06-04T09:00:00.000Z"),
				view("newer", "idle", "2026-06-04T11:00:00.000Z"),
				view("gone", "dead"),
			]),
		).toEqual({ id: "newer" });
	});

	it("prefers a live session over a more-recent idle one", () => {
		expect(
			pickResumeSession([
				view("idleNewer", "idle", "2026-06-04T11:00:00.000Z"),
				view("liveOlder", "live", "2026-06-04T09:00:00.000Z"),
			]),
		).toEqual({ id: "liveOlder" });
	});

	it("resumes a single idle session, never treating idle as ambiguous", () => {
		expect(pickResumeSession([view("only", "idle")])).toEqual({ id: "only" });
	});
});

describe("summariseSessions", () => {
	it("reports every attached session, leaving phantom removal to prune", () => {
		const out = summariseSessions([
			view("real", "idle", "2026-06-04T10:00:00.000Z"),
			view("phantom", "dead"),
		]);
		expect(out.map((s) => s.id).sort()).toEqual(["phantom", "real"]);
	});

	it("never flags a dead or detached session as the resume target", () => {
		const out = summariseSessions([
			view("phantom", "dead"),
			view("gone", "detached", "2026-06-04T12:00:00.000Z"),
		]);
		expect(out.filter((s) => s.resumeTarget)).toEqual([]);
	});

	it("orders newest activity first", () => {
		const out = summariseSessions([
			view("older", "idle", "2026-06-04T09:00:00.000Z"),
			view("newer", "idle", "2026-06-04T11:00:00.000Z"),
			view("detachedOld", "detached", "2026-06-03T08:00:00.000Z"),
		]);
		expect(out.map((s) => s.id)).toEqual(["newer", "older", "detachedOld"]);
	});

	it("flags only the session pickResumeSession would resume", () => {
		const out = summariseSessions([
			view("idleOlder", "idle", "2026-06-04T09:00:00.000Z"),
			view("liveWinner", "live", "2026-06-04T11:00:00.000Z"),
			view("detached", "detached", "2026-06-04T12:00:00.000Z"),
		]);
		expect(out.filter((s) => s.resumeTarget).map((s) => s.id)).toEqual([
			"liveWinner",
		]);
	});

	it("flags no target when nothing is resumable", () => {
		const out = summariseSessions([
			view("a", "detached", "2026-06-04T09:00:00.000Z"),
		]);
		expect(out.filter((s) => s.resumeTarget)).toEqual([]);
	});

	it("carries name and cwd through", () => {
		const out = summariseSessions([
			{
				id: "a",
				status: "active",
				liveness: "idle",
				lastActivity: "2026-06-04T09:00:00.000Z",
				name: "root cause dig",
				cwd: "/work/tree",
			},
		]);
		expect(out[0]).toMatchObject({ name: "root cause dig", cwd: "/work/tree" });
	});
});

describe("reopenedSession", () => {
	it("finds the session a pi command reopens, however it is written", () => {
		expect(reopenedSession("pi --session 01a1c1c6-a387")).toBe("01a1c1c6-a387");
		expect(reopenedSession("pi --model x --session=abc")).toBe("abc");
		expect(reopenedSession("pi --session '/s/a b.jsonl'")).toBe("/s/a b.jsonl");
		expect(reopenedSession("pi --session-id abc")).toBeUndefined();
		expect(reopenedSession("pi")).toBeUndefined();
	});
});

describe("reopenedCwd", () => {
	const ran = (id: string, cwd: string): SessionView => ({
		id,
		cwd,
		status: "active",
		liveness: "dead",
		lastActivity: "2026-11-11T08:00:00Z",
	});
	const sessions = [
		ran("01a1c1c6-a387-7000", "/src/harness"),
		ran("01a1c1c6-b000-7000", "/src/core"),
	];
	const base = {
		sessions,
		questDir: "/store/Q1",
		store: "/store",
		exists: all,
	};

	it("starts a reopen where its session ran, rather than in the newest tree", () => {
		expect(
			reopenedCwd({ ...base, command: "pi --session 01a1c1c6-a387-7000" }),
		).toBe("/src/harness");
	});

	it("takes a session by the start of its id only when one has it", () => {
		expect(reopenedCwd({ ...base, command: "pi --session 01a1c1c6-a" })).toBe(
			"/src/harness",
		);
		expect(
			reopenedCwd({ ...base, command: "pi --session 01a1c1c6" }),
			"two sessions start so",
		).toBeUndefined();
	});

	it("reads the folder from a log's header when the command names its path", () => {
		expect(
			reopenedCwd({
				...base,
				command: "pi --session /logs/x.jsonl",
				headerCwd: (path) => (path === "/logs/x.jsonl" ? "/src/y" : undefined),
			}),
		).toBe("/src/y");
	});

	it("leaves the choice to spawn for a fresh pi, a gone folder or the store", () => {
		expect(reopenedCwd({ ...base, command: "pi" })).toBeUndefined();
		expect(
			reopenedCwd({
				...base,
				command: "pi --session 01a1c1c6-a387-7000",
				exists: () => false,
			}),
		).toBeUndefined();
		expect(
			reopenedCwd({
				...base,
				sessions: [ran("s1", "/store/Q1")],
				command: "pi --session s1",
			}),
		).toBeUndefined();
	});

	it("says what chose the folder", () => {
		expect(describeCwdSource("reopened")).toBe(
			"the folder the reopened session ran in",
		);
	});
});
