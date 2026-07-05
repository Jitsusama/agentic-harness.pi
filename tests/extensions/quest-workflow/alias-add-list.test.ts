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
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "alias-add-list-"));
	registerBuiltinRefTypes();
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
	envGuard.leave();
});

describe("alias-add collision", () => {
	it("refuses a ref already on another quest, naming it", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const first = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "First",
		});
		if (!first.ok) throw new Error(first.guidance);
		const firstId = (first.details as { id: string }).id;
		await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#7",
		});

		const second = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "Second",
		});
		if (!second.ok) throw new Error(second.guidance);
		await handle(state, fakePi(), ctx, {
			action: "load",
			id: (second.details as { id: string }).id,
		});

		const result = await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#7",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toContain(firstId);
	});
});

describe("alias-add with a list", () => {
	it("adds every ref in a comma-separated list", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const created = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "Linked Work",
		});
		if (!created.ok) throw new Error(created.guidance);
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#1, github-issue:shop/world#2",
		});
		expect(result.ok).toBe(true);
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		// Two distinct aliases with clean values, not one alias whose
		// value swallowed the rest of the list.
		expect(readme).toMatch(/type: github-pr/);
		expect(readme).toMatch(/type: github-issue/);
		expect(readme).toMatch(/value: shop\/world#2/);
		expect(readme).not.toMatch(/value: 'shop\/world#1,/);
		expect(readme).not.toMatch(/value: "shop\/world#1,/);
	});

	it("reports already-present entries and stays idempotent on re-add", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const created = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "Linked Work",
		});
		if (!created.ok) throw new Error(created.guidance);
		await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#1",
		});
		// A list that re-states the present one and adds a new one: the
		// new lands, the present is reported, not duplicated.
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#1, github-issue:shop/world#2",
		});
		expect(result.ok).toBe(true);
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		expect(readme.match(/value: shop\/world#1/g)?.length).toBe(1);
		expect(readme).toMatch(/value: shop\/world#2/);
	});
});

describe("alias-remove contract parity", () => {
	async function questWithAliases() {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const created = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "Scrub Me",
		});
		if (!created.ok) throw new Error(created.guidance);
		await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#1, github-issue:shop/world#2",
		});
		return { state, ctx };
	}

	it("removes a comma-separated batch in one call", async () => {
		const { state, ctx } = await questWithAliases();
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-remove",
			ref: "github-pr:shop/world#1, github-issue:shop/world#2",
		});
		expect(result.ok).toBe(true);
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		expect(readme).not.toMatch(/type: github-pr/);
		expect(readme).not.toMatch(/type: github-issue/);
	});

	it("treats a no-op removal as success, matching alias-add", async () => {
		const { state, ctx } = await questWithAliases();
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-remove",
			ref: "github-pr:shop/world#999",
		});
		// alias-add reports an already-present no-op as ok; alias-remove
		// now reports a nothing-to-remove no-op as ok too.
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toMatch(/was not on this quest/i);
	});
});

describe("promote/demote reject a supplied priority", () => {
	it("refuses promote with a priority instead of ignoring it", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const created = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "Ladder",
		});
		if (!created.ok) throw new Error(created.guidance);
		const result = await handle(state, fakePi(), ctx, {
			action: "promote",
			priority: "driving",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toMatch(/drive, park or defer/i);
	});
});
