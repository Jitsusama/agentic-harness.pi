/**
 * Tidy and reclaim through the work tool: what a checkout has spent,
 * said and never removed, and the trees beside it nothing holds, taken
 * back with their branches kept.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { git } from "../../support/git-fixture.ts";
import { checkout, scratchDir, work } from "./worked.ts";

/** A worktree beside the checkout, at a branch trunk already holds. */
async function spareTree(): Promise<string> {
	const path = join(scratchDir(), "spare");
	await git(checkout(), "worktree", "add", "-q", "-b", "spare", path);
	return path;
}

describe("tidy", () => {
	it("says nothing has been spent when nothing has", async () => {
		const named = displayPath(checkout());
		const answer = await work({ action: "tidy", tree: checkout() });
		expect(answer.text).toContain(
			`${GLYPH.clean} Nothing in ${named} has been spent yet, against main.`,
		);
		expect(answer.text).toContain("Nothing has been removed.");
		expect(answer.details).toEqual({
			ok: true,
			removable: 0,
			reclaimable: 0,
		});
	});

	it("names a merged branch that can go, and leaves it", async () => {
		await git(checkout(), "branch", "done");
		const named = displayPath(checkout());
		const answer = await work({ action: "tidy", tree: checkout() });
		expect(answer.text).toContain(
			`${GLYPH.named} 1 thing in ${named} can go, against main.`,
		);
		expect(answer.text).toContain(`   ${GLYPH.named} done`);
		expect(answer.details).toMatchObject({ removable: 1 });
		expect(await git(checkout(), "branch", "--list", "done")).toContain("done");
	});

	it("names a tree nothing holds, and sends the reader to reclaim", async () => {
		const spare = await spareTree();
		const answer = await work({ action: "tidy", tree: checkout() });
		expect(answer.text).toContain(
			`${displayPath(spare)}, a tree nothing holds (spare)`,
		);
		expect(answer.text).toContain("work reclaim takes them");
		expect(answer.details).toMatchObject({ reclaimable: 1 });
		expect(existsSync(spare), "tidy removes nothing").toBe(true);
	});
});

describe("reclaim", () => {
	it("says no tree is going spare when none is", async () => {
		const named = displayPath(checkout());
		const answer = await work({ action: "reclaim", tree: checkout() });
		expect(answer.text).toBe(
			`${GLYPH.clean} No tree beside ${named} is going spare, against main.`,
		);
		expect(answer.details).toEqual({ ok: true, reclaimed: 0 });
	});

	it("takes back a tree nothing holds and keeps its branch", async () => {
		const spare = await spareTree();
		const named = displayPath(checkout());
		const answer = await work({ action: "reclaim", tree: checkout() });
		expect(answer.text).toContain(
			`${GLYPH.named} Took back 1 tree beside ${named}.`,
		);
		expect(answer.text).toContain(
			`   ${GLYPH.named} ${displayPath(spare)}, spare kept`,
		);
		expect(answer.text).toContain("Every branch kept is still where it was.");
		expect(answer.details).toEqual({ ok: true, reclaimed: 1 });
		expect(existsSync(spare), "the tree is gone").toBe(false);
		expect(await git(checkout(), "branch", "--list", "spare")).toContain(
			"spare",
		);
	});

	it("refuses a tree that is neither held nor in a checkout", async () => {
		const answer = await work({ action: "reclaim", tree: "/nowhere/at/all" });
		expect(answer.text).toMatch(
			new RegExp(`^${GLYPH.refused} No held tree called /nowhere/at/all`),
		);
	});
});
