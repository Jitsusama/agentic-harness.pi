/**
 * What a sealed quest says it leaves on disk.
 *
 * Conclude clears a workspace's tmp/ and keeps the rest in case the
 * quest reopens. Saying how much is kept is what lets the person decide
 * whether to free it, without walking directories by hand.
 */

import { describe, expect, it } from "vitest";
import { workspaceKept } from "../../../extensions/quest-workflow/verbs/stage.ts";
import type { Measure } from "../../../lib/internal/quest/footprint.ts";

const ID = "QEST-20261001-AAAAAA";

describe("workspaceKept", () => {
	it("says what the scratch folder still holds and where to see what could go", async () => {
		const asked: string[] = [];
		const measure: Measure = async (path) => {
			asked.push(path);
			return { bytes: 2.5e9, complete: true };
		};
		const said = await workspaceKept(ID, undefined, measure);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(new RegExp(`${ID}$`));
		expect(said).toBe(
			"Its scratch folder still holds 2.5 GB, kept in case the quest reopens; `spend` with disk lists what could go across quests.",
		);
	});

	it("says it was cut short rather than giving a wrong figure", async () => {
		const said = await workspaceKept(ID, undefined, async () => ({
			bytes: 3e9,
			complete: false,
		}));
		expect(said).toContain("still holds at least 3.0 GB");
	});

	it("says nothing when the quest has no workspace", async () => {
		expect(await workspaceKept(ID, undefined, async () => undefined)).toBe(
			undefined,
		);
		expect(await workspaceKept(null, undefined, async () => undefined)).toBe(
			undefined,
		);
	});
});
