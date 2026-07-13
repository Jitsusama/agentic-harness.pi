import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadWorkspaceStore,
	planWorkspaceRestore,
	recordWorkspaceEntry,
	restoreRecipe,
	saveWorkspaceStore,
	snapshotFor,
} from "../../../../lib/internal/quest/workspace-snapshot";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workspace-snap-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const t0 = "2026-06-01T00:00:00.000Z";
const t1 = "2026-06-02T00:00:00.000Z";

describe("recordWorkspaceEntry", () => {
	it("accumulates one entry per session under a workspace key", () => {
		let store = {};
		store = recordWorkspaceEntry(store, "mux-a", {
			questId: "QEST-1",
			cwd: "/w/one",
			sessionId: "sess-1",
			pane: "10",
			now: t0,
		});
		store = recordWorkspaceEntry(store, "mux-a", {
			questId: "QEST-2",
			cwd: "/w/two",
			sessionId: "sess-2",
			pane: "11",
			now: t0,
		});
		const snap = snapshotFor(store, "mux-a");
		expect(snap?.entries.map((e) => e.sessionId)).toEqual(["sess-1", "sess-2"]);
	});

	it("updates a session in place rather than duplicating it", () => {
		let store = recordWorkspaceEntry({}, "mux-a", {
			questId: "QEST-1",
			cwd: "/w/old",
			sessionId: "sess-1",
			pane: "10",
			now: t0,
		});
		store = recordWorkspaceEntry(store, "mux-a", {
			questId: "QEST-9",
			cwd: "/w/new",
			sessionId: "sess-1",
			pane: "10",
			now: t1,
		});
		const snap = snapshotFor(store, "mux-a");
		expect(snap?.entries).toHaveLength(1);
		expect(snap?.entries[0]).toMatchObject({
			questId: "QEST-9",
			cwd: "/w/new",
		});
	});

	it("keeps workspaces separate", () => {
		let store = recordWorkspaceEntry({}, "mux-a", {
			questId: "QEST-1",
			cwd: "/w/a",
			sessionId: "sess-a",
			now: t0,
		});
		store = recordWorkspaceEntry(store, "mux-b", {
			questId: "QEST-2",
			cwd: "/w/b",
			sessionId: "sess-b",
			now: t0,
		});
		expect(snapshotFor(store, "mux-a")?.entries).toHaveLength(1);
		expect(snapshotFor(store, "mux-b")?.entries).toHaveLength(1);
		expect(snapshotFor(store, "mux-c")).toBeUndefined();
	});
});

describe("load/save round-trip", () => {
	it("persists and reloads the store", () => {
		const path = join(dir, "snapshots.json");
		const store = recordWorkspaceEntry({}, "mux-a", {
			questId: "QEST-1",
			cwd: "/w/a",
			sessionId: "sess-a",
			pane: "10",
			now: t0,
		});
		saveWorkspaceStore(path, store);
		expect(loadWorkspaceStore(path)).toEqual(store);
	});

	it("reads a missing store as empty", () => {
		expect(loadWorkspaceStore(join(dir, "absent.json"))).toEqual({});
	});
});

describe("planWorkspaceRestore", () => {
	it("excludes entries whose pane is currently live", () => {
		let store = recordWorkspaceEntry({}, "mux-a", {
			questId: "QEST-1",
			cwd: "/w/a",
			sessionId: "sess-a",
			pane: "10",
			now: t0,
		});
		store = recordWorkspaceEntry(store, "mux-a", {
			questId: "QEST-2",
			cwd: "/w/b",
			sessionId: "sess-b",
			pane: "11",
			now: t0,
		});
		const snap = snapshotFor(store, "mux-a");
		if (!snap) throw new Error("snapshot missing");
		const plan = planWorkspaceRestore(snap, new Set(["10"]));
		expect(plan.alreadyLive.map((e) => e.sessionId)).toEqual(["sess-a"]);
		expect(plan.toRestore.map((e) => e.sessionId)).toEqual(["sess-b"]);
	});
});

describe("restoreRecipe", () => {
	it("emits a resume command per entry", () => {
		const recipe = restoreRecipe([
			{ questId: "QEST-1", cwd: "/w/a", sessionId: "sess-a", updated: t0 },
		]);
		expect(recipe).toHaveLength(1);
		expect(recipe[0]).toContain("/w/a");
		expect(recipe[0]).toContain("pi --session sess-a");
	});

	it("single-quotes a cwd with a space so cd does not break", () => {
		const recipe = restoreRecipe([
			{
				questId: "QEST-1",
				cwd: "/w/a dir",
				sessionId: "sess-a",
				updated: t0,
			},
		]);
		expect(recipe[0]).toContain("cd '/w/a dir'");
	});

	it("escapes an embedded single quote so the path cannot break out", () => {
		const recipe = restoreRecipe([
			{
				questId: "QEST-1",
				cwd: "/w/a'; rm -rf ~",
				sessionId: "sess-a",
				updated: t0,
			},
		]);
		// The dangerous quote is closed, escaped and reopened, never left
		// as a bare quote that ends the quoting.
		expect(recipe[0]).toContain("'/w/a'\\''; rm -rf ~'");
		expect(recipe[0]).not.toContain("&& rm -rf");
	});
});
