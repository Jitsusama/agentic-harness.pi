import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx(cwd: string, sessionId = "sess-1") {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return result.details as { id: string; path: string };
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-scope-"));
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
	envGuard.leave();
});

describe("priority verbs", () => {
	it("promote shifts the loaded quest up one bucket", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "promote",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/priority: driving/);
	});

	it("park jumps the loaded quest to bench", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "park",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/priority: bench/);
	});

	it("defer sets priority to someday", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "defer" });
		const text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/priority: someday/);
	});

	it("drive sets priority to driving", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "drive" });
		const text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/priority: driving/);
	});
});

describe("conclude / retire scope", () => {
	it("with no focused document, defaults to quest scope", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/status: concluded/);
	});

	it("cascades on conclude: resets priority to someday and seals documents", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "drive" });
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "think",
			kind: "plan",
			note: "scope",
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "draft",
			title: "The plan",
		});
		const planPath = state.documentPath as string;
		// Unfocus so conclude targets the quest, not the focused plan.
		await handle(state, fakePi(), fakeCtx(tmpRoot), { action: "unfocus" });

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			scope: "quest",
		});
		expect(result.ok).toBe(true);

		const quest = readFileSync(a.path, "utf8");
		expect(quest).toMatch(/status: concluded/);
		expect(quest).toMatch(/priority: someday/);
		const plan = readFileSync(planPath, "utf8");
		expect(plan).toMatch(/stage: concluded/);
	});

	it("retire requires a reason in quest scope", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "retire",
		});
		expect(result.ok).toBe(false);
	});

	it("retire stamps status retired when reason is given", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "retire",
			reason: "no longer relevant",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/status: retired/);
	});

	it("warns when the primary plan still has unchecked items", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "think",
			kind: "plan",
			note: "scope",
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "draft",
			title: "The plan",
		});
		// Replace the scaffold body with a known checkbox set:
		// one done, one open.
		writeFileSync(
			state.documentPath as string,
			"# The plan\n\n## Work\n- [x] done item\n- [ ] open item\n",
		);
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			scope: "quest",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.message).toMatch(/unchecked|open work|item/i);
		const drift = (
			result.details as { planDrift?: { done: number; total: number } }
		).planDrift;
		expect(drift).toMatchObject({ done: 1, total: 2 });
	});

	it("does not warn when the primary plan is fully checked", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "think",
			kind: "plan",
			note: "scope",
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "draft",
			title: "The plan",
		});
		writeFileSync(
			state.documentPath as string,
			"# The plan\n\n## Work\n- [x] done item\n",
		);
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			scope: "quest",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(
			(result.details as { planDrift?: unknown }).planDrift,
		).toBeUndefined();
	});

	it("explicit scope=document with no focused document refuses cleanly", async () => {
		const state = buildState();
		const a = await createQuest(state, "Q");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "conclude",
			scope: "document",
		});
		expect(result.ok).toBe(false);
	});
});

describe("tree and expand", () => {
	it("tree returns top-level quests with their children as listing rows", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Child",
			parent: parent.id,
			kind: "subquest",
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree",
		});
		expect(result.ok).toBe(true);
		const details = result.details as {
			listing: { rows: { id: string; depth: number }[] };
		};
		const parentIdx = details.listing.rows.findIndex((r) => r.id === parent.id);
		expect(parentIdx).toBeGreaterThanOrEqual(0);
		expect(details.listing.rows[parentIdx].depth).toBe(0);
		// Child sits at depth 1 directly after its parent
		// in the flattened listing.
		expect(details.listing.rows[parentIdx + 1].depth).toBe(1);
		expect(result.message).toMatch(/^ {2}/m);
	});

	it("expand returns the named subtree", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Child",
			parent: parent.id,
			kind: "subquest",
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "expand",
			id: parent.id,
		});
		expect(result.ok).toBe(true);
		// expand attaches a listing payload with the parent
		// at depth 0 and each child at depth 1.
		const details = result.details as {
			listing: { rows: { id: string; depth: number }[] };
		};
		expect(details.listing.rows[0].id).toBe(parent.id);
		expect(details.listing.rows[0].depth).toBe(0);
		const childRows = details.listing.rows.filter((r) => r.depth === 1);
		expect(childRows.length).toBe(1);
	});

	it("surfaces orphan subquests under a synthetic orphans group", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Orphan",
			parent: "QEST-20260603-NOPARENT",
			kind: "subquest",
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree",
		});
		expect(result.ok).toBe(true);
		const details = result.details as {
			listing: {
				rows: {
					id: string;
					depth: number;
					updated: string;
					parent: string | null;
				}[];
			};
		};
		const orphansRow = details.listing.rows.find((r) => r.id === "(orphans)");
		expect(orphansRow).toBeDefined();
		expect(orphansRow?.depth).toBe(0);
		// Sparse row: the synthetic node has no discovery
		// entry, so updated is empty and parent is null.
		expect(orphansRow?.updated).toBe("");
		expect(orphansRow?.parent).toBeNull();
		// The orphan child sits at depth 1 under the group.
		const childRows = details.listing.rows.filter((r) => r.depth === 1);
		expect(childRows.length).toBe(1);
	});
});

describe("find with extended filters", () => {
	it("filters by parent=null for top-level quests", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Child",
			parent: parent.id,
			kind: "subquest",
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			parent: "null",
		});
		const rows = (
			result.details as {
				listing: { rows: { id: string; kind: string }[] };
			}
		).listing.rows;
		expect(rows.every((r) => r.kind !== "subquest")).toBe(true);
		expect(rows.some((r) => r.id === parent.id)).toBe(true);
	});

	it("accepts field=activity and rejects an unknown field", async () => {
		const state = buildState();
		await createQuest(state, "Q");
		const ok = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			field: "activity",
		});
		expect(ok.ok).toBe(true);

		// Under an activity window, a quest with no recorded activity is
		// excluded rather than slipping through on an undefined date.
		const windowed = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			field: "activity",
			since: "2026-01-01",
		});
		const rows = (windowed.details as { listing: { rows: { id: string }[] } })
			.listing.rows;
		expect(rows).toHaveLength(0);
		const bad = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			field: "banana",
		});
		expect(bad.ok).toBe(false);
	});

	it("filters by refType", async () => {
		const state = buildState();
		const a = await createQuest(state, "Aliased");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "alias-add",
			ref: "github-pr:shop/world#1",
		});
		await createQuest(state, "Plain");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "find",
			refType: "github-pr",
		});
		const rows = (result.details as { listing: { rows: { id: string }[] } })
			.listing.rows;
		expect(rows.map((r) => r.id)).toEqual([a.id]);
	});
});

describe("show projection", () => {
	it("includes documents, sessions and Echoes", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		// Scaffold a plan document under the loaded quest.
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "think",
			note: "investigate",
			kind: "plan",
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "draft",
			title: "First plan",
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "session-attach",
			name: "primary",
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "show",
		});
		expect(result.ok).toBe(true);
		const projection = (
			result.details as {
				projection: {
					documents: { kind: string; stage: string }[];
					sessions: { id: string }[];
					links: { quests: unknown[]; refs: unknown[]; urls: unknown[] };
					echoes: unknown[];
				};
			}
		).projection;
		expect(projection.documents.length).toBe(1);
		expect(projection.documents[0].kind).toBe("plan");
		expect(projection.sessions.length).toBe(1);
		expect(projection.sessions[0].id).toBe("sess-1");
		expect(projection.links).toBeDefined();
		expect(projection.echoes).toBeDefined();
		// renderShow emits a Sessions block listing the attached session.
		if (!result.ok) throw new Error("expected ok");
		expect(result.message).toContain("Sessions:");
		expect(result.message).toContain("sess-1");
	});
});
