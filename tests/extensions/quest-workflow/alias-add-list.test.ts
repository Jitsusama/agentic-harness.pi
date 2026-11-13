import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import { findQuestEntry } from "../../../lib/core/quest/lifecycle.ts";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { createEnvGuard } from "./_helpers.ts";

let tmpRoot: string;

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
		expect(result).toMatchObject({ ok: false });
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
		expect(result).toMatchObject({ ok: true });
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
		expect(result).toMatchObject({ ok: true });
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		expect(readme.match(/value: shop\/world#1/g)?.length).toBe(1);
		expect(readme).toMatch(/value: shop\/world#2/);
	});
});

describe("alias-add and alias-remove on the quest `id` names", () => {
	// On 12 November an alias meant for another quest was written to the
	// loaded one, and reported as added.
	async function twoQuests() {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const ids: string[] = [];
		for (const title of ["Loaded", "Named"]) {
			const created = await handle(state, fakePi(), ctx, {
				action: "create",
				title,
			});
			if (!created.ok) throw new Error(created.guidance);
			ids.push((created.details as { id: string }).id);
		}
		const [loaded = "", named = ""] = ids;
		await handle(state, fakePi(), ctx, { action: "load", id: loaded });
		const readme = (id: string) =>
			readFileSync(
				join(findQuestEntry(state, id)?.dir ?? "", "README.md"),
				"utf8",
			);
		return { state, ctx, loaded, named, readme };
	}

	it("adds to the named quest, not the loaded one, and says which", async () => {
		const { state, ctx, loaded, named, readme } = await twoQuests();
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-add",
			id: named,
			ref: "swarm:delta",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message, "the quest it went to").toContain(named);
		expect(readme(named), "the named quest's aliases").toMatch(/value: delta/);
		expect(readme(loaded), "the loaded quest's aliases").not.toMatch(
			/value: delta/,
		);
	});

	it("removes from the named quest, leaving the loaded one's", async () => {
		const { state, ctx, loaded, named, readme } = await twoQuests();
		for (const [id, team] of [
			[loaded, "alpha"],
			[named, "beta"],
		]) {
			await handle(state, fakePi(), ctx, {
				action: "alias-add",
				id,
				ref: `swarm:${team}`,
			});
		}
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-remove",
			id: named,
			ref: "swarm:beta, swarm:alpha",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message, "the quest it came from").toContain(named);
		expect(readme(named), "the named quest's alias").not.toMatch(/value: beta/);
		expect(readme(loaded), "the loaded quest's alias").toMatch(/value: alpha/);
	});

	it("refuses an id no quest has, writing nothing", async () => {
		const { state, ctx, loaded, readme } = await twoQuests();
		for (const action of ["alias-add", "alias-remove"] as const) {
			const result = await handle(state, fakePi(), ctx, {
				action,
				id: "QEST-20990101-NOSUCH",
				ref: "swarm:delta",
			});
			expect(result.ok, `${action} took an unknown id`).toBe(false);
		}
		expect(readme(loaded), "the loaded quest's aliases").not.toMatch(
			/value: delta/,
		);
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
		expect(result).toMatchObject({ ok: true });
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
		expect(result).toMatchObject({ ok: true });
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
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toMatch(/drive, park or defer/i);
	});
});
