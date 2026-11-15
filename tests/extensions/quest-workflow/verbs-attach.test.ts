/**
 * The quest verbs that tie things to a quest: an alias, a session, and
 * the tree a working folder resolves to.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	questIdFromCwd,
} from "../../../extensions/quest-workflow/verbs/lifecycle.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { fakeCtx } from "./_helpers.ts";
import { buildState, createQuest, fixture } from "./support/verbs.ts";

describe("questIdFromCwd", () => {
	function addTree(readmePath: string, treePath: string): void {
		const text = readFileSync(readmePath, "utf8");
		const block = `\ntrees:\n  - path: ${treePath}\n    providerId: dev-tree\n    repoRoot: ${treePath}\n    origin: scaffolded\n---\n`;
		writeFileSync(readmePath, text.replace(/\n---\n/, block));
	}

	it("prefers a live quest over a sealed one sharing a tree path", async () => {
		const state = buildState();
		const treePath = join(fixture.root, "shared-tree");
		mkdirSync(treePath, { recursive: true });
		// Sealed quest created first, so without a status preference its
		// tree would win the tie by iteration order.
		const sealed = await createQuest(state, "Sealed");
		const live = await createQuest(state, "Live");
		addTree(sealed.path, treePath);
		addTree(live.path, treePath);
		const withSeal = readFileSync(sealed.path, "utf8").replace(
			/^status: active$/m,
			"status: concluded",
		);
		writeFileSync(sealed.path, withSeal);

		expect(questIdFromCwd(state, treePath)).toBe(live.id);
	});
});

describe("alias verbs", () => {
	it("adds and removes an alias", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});
		const add = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "alias-add",
			ref: "github-pr:shop/world#47281",
		});
		expect(add).toMatchObject({ ok: true });
		const text = readFileSync(a.path, "utf8");
		expect(text).toContain("type: github-pr");
		expect(text).toContain("value: shop/world#47281");

		const remove = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "alias-remove",
			ref: "github-pr:shop/world#47281",
		});
		expect(remove).toMatchObject({ ok: true });
		const after = readFileSync(a.path, "utf8");
		// Frontmatter `aliases` list should be empty; Journey
		// log keeps the historical mention.
		expect(after).toMatch(/aliases: \[\s*\]/);
	});

	it("refuses an unrecognised input", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "alias-add",
			ref: "not a valid alias",
		});
		expect(result).toMatchObject({ ok: false });
	});
});

describe("session verbs", () => {
	it("attaches the current session and then detaches it", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});
		const attach = await handle(state, fakePi(), fakeCtx(fixture.root, "sess-99"), {
			action: "session-attach",
			name: "investigation",
		});
		expect(attach).toMatchObject({ ok: true });
		let text = readFileSync(a.path, "utf8");
		expect(text).toContain("id: sess-99");
		expect(text).toContain("name: investigation");
		expect(text).toContain("status: active");

		const detach = await handle(state, fakePi(), fakeCtx(fixture.root, "sess-99"), {
			action: "session-detach",
		});
		expect(detach).toMatchObject({ ok: true });
		text = readFileSync(a.path, "utf8");
		expect(text).toMatch(/status: detached/);
	});

	it("acts on the quest `id` names, not the one loaded", async () => {
		// 29 October: a detach naming another quest found nothing on the
		// loaded one, and the moved session stayed active where it was.
		const state = buildState();
		const loaded = await createQuest(state, "Loaded");
		const other = await createQuest(state, "Other");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: loaded.id,
		});
		const named = { id: other.id, sessionId: "sess-elsewhere" };
		const attach = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "session-attach",
			...named,
		});
		expect(attach).toMatchObject({ ok: true });
		expect(readFileSync(other.path, "utf8")).toContain("id: sess-elsewhere");
		expect(readFileSync(loaded.path, "utf8")).not.toContain("sess-elsewhere");

		const rename = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "session-rename",
			name: "moved",
			...named,
		});
		expect(rename).toMatchObject({ ok: true });
		const detach = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "session-detach",
			...named,
		});
		expect(detach).toMatchObject({ ok: true });
		const text = readFileSync(other.path, "utf8");
		expect(text).toContain("name: moved");
		expect(text).toMatch(/status: detached/);
	});
});
