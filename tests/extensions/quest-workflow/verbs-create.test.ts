/**
 * Creating a quest through the verbs, from a title or a URL, what a
 * create refuses, and how an action's name is read: its synonyms and
 * the suggestion an unknown one gets.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import { registerUrlFetcher } from "../../../lib/quest/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { fakeCtx } from "./_helpers.ts";
import { buildState, createQuest, fixture } from "./support/verbs.ts";

describe("URL-seeded create", () => {
	it("dedups against an existing quest with the same alias", async () => {
		const state = buildState();
		// First quest: add the alias.
		const a = await createQuest(state, "Quest with alias");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "alias-add",
			ref: "github-pr:shop/world#47281",
		});

		// Try to create another from the URL form (the
		// github-pr ref type knows how to parse the URL).
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			url: "https://github.com/shop/world/pull/47281",
		});
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) {
			expect(result.guidance).toContain(a.id);
		}
	});

	it("seeds title and originator from a registered fetcher", async () => {
		const state = buildState();
		registerUrlFetcher({
			type: "github-pr",
			async fetch() {
				return {
					title: "Seeded title",
					excerpt: "Body content",
					originator: { type: "github", value: "octocat" },
				};
			},
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			url: "https://github.com/shop/world/pull/99999",
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("unreachable");
		const path = (result.details as { path: string }).path;
		const text = readFileSync(path, "utf8");
		expect(text).toContain("# Seeded title");
		expect(text).toContain("Body content");
		expect(text).toContain("@octocat");
	});

	it("hands the fetcher the call's signal, so stopping the call stops the fetch", async () => {
		const state = buildState();
		const handed: Array<AbortSignal | undefined> = [];
		registerUrlFetcher({
			type: "github-pr",
			async fetch(_ref, options) {
				handed.push(options?.signal);
				return { title: "Seeded title" };
			},
		});
		const controller = new AbortController();
		await handle(
			state,
			fakePi(),
			fakeCtx(fixture.root),
			{ action: "create", url: "https://github.com/shop/world/pull/55555" },
			controller.signal,
		);
		expect(handed).toEqual([controller.signal]);
	});

	it("reads the word null as no URL, and creates from the title", async () => {
		// A caller filling every field from a template passes "null" for
		// the field it has nothing for; nothing would ever register it.
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "From a Template",
			url: "null",
		});
		if (!result.ok) throw new Error(result.guidance);
		const path = (result.details as { path: string }).path;
		expect(readFileSync(path, "utf8")).toContain("# From a Template");
	});

	it("refuses with guidance when neither URL hint nor title is given", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			url: "https://github.com/shop/world/pull/77777",
		});
		// No fetcher registered, no title param: refuse.
		expect(result).toMatchObject({ ok: false });
	});
});

describe("action aliases and refusals", () => {
	it("status is a synonym for show on a loaded quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha quest");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "status",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(result.message).toContain(a.id);
	});

	it("refuses unknown actions with a Levenshtein suggestion", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "lst",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unexpected ok");
		expect(result.guidance).toContain('Did you mean "list"');
	});
});

describe("create validation", () => {
	it("refuses an out-of-vocabulary priority instead of minting an invisible quest", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Bad Priority",
			priority: "high",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toMatch(/priority/i);
	});

	it("refuses a parent that does not exist", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Orphan",
			parent: "QEST-20260101-NOEXST",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.guidance).toMatch(/parent/i);
	});

	it("accepts a valid priority and an existing parent", async () => {
		const state = buildState();
		const parent = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Real Parent",
		});
		if (!parent.ok) throw new Error(parent.guidance);
		const parentId = (parent.details as { id: string }).id;
		const child = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "create",
			title: "Real Child",
			kind: "subquest",
			parent: parentId,
			priority: "queued",
		});
		expect(child).toMatchObject({ ok: true });
	});
});
