import { describe, expect, it } from "vitest";
import {
	pickResumeSession,
	resolveSpawnCwd,
	summariseSessions,
} from "../../../../lib/internal/quest/reopen";
import type { SessionView } from "../../../../lib/internal/quest/session-liveness";
import type { QuestTree } from "../../../../lib/quest/types";

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

	it("falls back to the quest dir when nothing else resolves", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			trees: [],
			sessions: [],
			exists: none,
		});
		expect(result).toEqual({ cwd: "/q", source: "questDir" });
	});

	it("flags the heal when a recorded path was missing and it falls through to the quest dir", () => {
		const result = resolveSpawnCwd({
			questDir: "/q",
			// A recorded tree path that no longer exists: resolution
			// heals past it, and nothing else resolves, so it lands on the
			// quest dir but must still report that a stale record was met.
			trees: [{ path: "/gone" }],
			sessions: [],
			exists: none,
		});
		expect(result).toEqual({ cwd: "/q", source: "questDir", healed: true });
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
		expect(result && "ambiguous" in result).toBe(true);
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
		expect(out.some((s) => s.resumeTarget)).toBe(false);
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
		expect(out.some((s) => s.resumeTarget)).toBe(false);
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
