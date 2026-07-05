import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateOwner } from "../../../extensions/quest-workflow/lookup";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => "sess-1",
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-locate-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("locateOwner", () => {
	it("resolves a quest id, its document id and its alias to the owning quest", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Owner",
		});
		const questId = state.questId as string;
		await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			kind: "plan",
			note: "investigate",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			title: "The Plan",
		});
		const docId = state.documentId as string;
		await handle(state, fakePi(), fakeCtx(), {
			action: "alias-add",
			ref: "github-pr:Shopify/world#123",
		});

		const byQuest = locateOwner(state, questId);
		expect(byQuest).toHaveLength(1);
		expect(byQuest[0]).toMatchObject({ questId, matchKind: "quest" });

		const byDoc = locateOwner(state, docId);
		expect(byDoc).toHaveLength(1);
		expect(byDoc[0]).toMatchObject({ questId, matchKind: "document" });

		const byAlias = locateOwner(state, "github-pr:Shopify/world#123");
		expect(byAlias).toHaveLength(1);
		expect(byAlias[0]).toMatchObject({ questId, matchKind: "alias" });

		expect(locateOwner(state, "nothing-matches")).toHaveLength(0);
		// The empty needle resolves to nothing rather than matching all.
		expect(locateOwner(state, "")).toHaveLength(0);
		expect(locateOwner(state, "   ")).toHaveLength(0);
	});

	it("resolves a session id to the quest tracking it", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			title: "Session Owner",
		});
		const questId = state.questId as string;
		await handle(state, fakePi(), fakeCtx(), {
			action: "load",
			id: questId,
		});

		const bySession = locateOwner(state, "sess-1");
		expect(bySession).toHaveLength(1);
		expect(bySession[0]).toMatchObject({ questId, matchKind: "session" });
	});

	it("surfaces every owner when a needle resolves ambiguously", () => {
		// Two quests carry the same alias, as legacy colliding stores do.
		// locate must return both rather than hiding the ambiguity.
		const state = buildState();
		const write = (id: string) => {
			const dir = join(tmpRoot, "quests", id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "README.md"),
				`---\nid: ${id}\nkind: quest\nparent: null\nstatus: active\npriority: someday\nrank: 1\nstarted: 2026-01-01\nupdated: 2026-01-01\naliases:\n  - type: github-pr\n    value: shop/world#9\n---\n\n# ${id}\n\nBody.\n`,
			);
		};
		write("QEST-20260101-OWNER1");
		write("QEST-20260101-OWNER2");

		const hits = locateOwner(state, "github-pr:shop/world#9");
		expect(hits).toHaveLength(2);
		expect(hits.every((h) => h.matchKind === "alias")).toBe(true);
		expect(hits.map((h) => h.questId).sort()).toEqual([
			"QEST-20260101-OWNER1",
			"QEST-20260101-OWNER2",
		]);
	});
});
