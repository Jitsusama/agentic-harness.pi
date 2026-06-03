import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";

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
	return createQuestState({ homeDir: tmpRoot, dataDir: tmpRoot });
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

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-scope-"));
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
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
	it("tree returns top-level quests with their children", async () => {
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
		const tree = (
			result.details as { tree: { id: string; children: { id: string }[] }[] }
		).tree;
		const found = tree.find((n) => n.id === parent.id);
		expect(found).toBeDefined();
		expect(found?.children.length).toBe(1);
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
		const node = (
			result.details as { node: { id: string; children: { id: string }[] } }
		).node;
		expect(node.id).toBe(parent.id);
		expect(node.children.length).toBe(1);
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
		const tree = (
			result.details as {
				tree: { id: string; children: { id: string }[] }[];
			}
		).tree;
		const orphans = tree.find((n) => n.id === "(orphans)");
		expect(orphans).toBeDefined();
		expect(orphans?.children.length).toBe(1);
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
		const hits = (result.details as { hits: { id: string; kind: string }[] })
			.hits;
		expect(hits.every((h) => h.kind !== "subquest")).toBe(true);
		expect(hits.some((h) => h.id === parent.id)).toBe(true);
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
		const hits = (result.details as { hits: { id: string }[] }).hits;
		expect(hits.map((h) => h.id)).toEqual([a.id]);
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
	});
});
