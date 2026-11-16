/**
 * The quest verbs that place a quest among its siblings: the reorder
 * verbs, and the rank a quest is created at.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { parseQuestFrontMatter } from "../../../../lib/quest/index.ts";
import { at } from "../../../support/at.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { fakeCtx } from "../_helpers.ts";
import { buildState, createQuest, fixture } from "../support/verbs.ts";

describe("reorder verbs", () => {
	it("top moves the loaded quest to rank 1 and shifts siblings to fixed positions", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");

		// Seed deterministic positions with explicit
		// before/after actions rather than sink. Every quest
		// starts at rank 1, so a sink-only seed relies on the
		// rank tiebreaker (alphabetical id sort), and ids
		// carry random 6-char suffixes that don't honour the
		// Alpha/Bravo/Charlie creation order. The explicit
		// placements below make the seed order independent
		// of the id suffixes.
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: b.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "after",
			target: a.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: c.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "after",
			target: b.id,
		});
		// Now ranks are: Alpha=1, Bravo=2, Charlie=3.

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "top",
		});
		expect(result).toMatchObject({ ok: true });

		// After `top` on Charlie: Charlie=1, Alpha=2,
		// Bravo=3. Each rank is asserted exactly.
		const cText = readFileSync(c.path, "utf8");
		expect(cText).toMatch(/^rank: 1$/m);
		const aText = readFileSync(a.path, "utf8");
		expect(aText).toMatch(/^rank: 2$/m);
		const bText = readFileSync(b.path, "utf8");
		expect(bText).toMatch(/^rank: 3$/m);
	});

	it("excludes a sealed same-bucket quest from the reorder", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");
		// Simulate legacy drift: seal Bravo but leave it in the live
		// bucket, the exact shape the status cascade now prevents.
		const sealed = readFileSync(b.path, "utf8").replace(
			/^status: active$/m,
			"status: concluded",
		);
		writeFileSync(b.path, sealed);
		const bRankBefore = readFileSync(b.path, "utf8").match(
			/^rank: (\d+)/m,
		)?.[1];

		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: c.id,
		});
		await handle(state, fakePi(), fakeCtx(fixture.root), { action: "top" });

		const bRankAfter = readFileSync(b.path, "utf8").match(/^rank: (\d+)/m)?.[1];
		expect(bRankAfter).toBe(bRankBefore);
		// Charlie took rank 1 and Alpha followed; Bravo stayed put.
		expect(readFileSync(c.path, "utf8")).toMatch(/^rank: 1$/m);
		expect(readFileSync(a.path, "utf8")).toMatch(/^rank: 2$/m);
	});

	it("before/after needs a target", async () => {
		const state = buildState();
		await createQuest(state, "Alpha");
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "before",
		});
		expect(result).toMatchObject({ ok: false });
	});
});

describe("create rank assignment", () => {
	function rankOf(path: string): number {
		const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
		if (!parsed) throw new Error("unreadable quest frontmatter");
		return parsed.frontMatter.rank;
	}

	it("gives quests in the same group distinct, increasing ranks", async () => {
		const state = buildState();
		const first = await createQuest(state, "First top-level");
		const second = await createQuest(state, "Second top-level");
		const third = await createQuest(state, "Third top-level");

		const ranks = [rankOf(first.path), rankOf(second.path), rankOf(third.path)];
		expect(new Set(ranks).size).toBe(3);
		expect(ranks[0]).toBeLessThan(at(ranks, 1));
		expect(ranks[1]).toBeLessThan(at(ranks, 2));
	});
});
