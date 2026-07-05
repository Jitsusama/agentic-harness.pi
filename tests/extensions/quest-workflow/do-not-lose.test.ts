import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QUEST_ACTIONS } from "../../../extensions/quest-workflow/actions";

/**
 * The do-not-lose set from BRIF-20260704-OUD7YZ, made executable.
 *
 * The quest-workflow rework (PLAN-20260704-Y1KP37) reshapes the
 * extension across every family. These are the load-bearing
 * capabilities the current design earns; the rework adds to this
 * set and must never remove a row. This suite is the tripwire:
 * each capability names the tests that guard it, and if a guard
 * disappears (or a core verb is dropped from the surface) this
 * file fails, forcing a conscious decision rather than a silent
 * regression.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface Capability {
	name: string;
	/** Test files that would fail if this capability regressed. */
	guards: string[];
	/** Set when the capability has no mechanical guard, with why. */
	waiver?: string;
}

const DO_NOT_LOSE: Capability[] = [
	{
		name: "One tool with one verb surface",
		guards: ["tests/extensions/quest-workflow/actions.test.ts"],
	},
	{
		name: "Single hierarchical model, documents under quests",
		guards: [
			"tests/scripts/migrate-quests-canonical.test.ts",
			"tests/lib/internal/quest/discovery-cache.test.ts",
		],
	},
	{
		name: "Four-kind stage machine and focus loop",
		guards: ["tests/extensions/quest-workflow/machine.test.ts"],
	},
	{
		name: "Discipline gate with honest-by-destination classification",
		guards: [
			"tests/lib/internal/quest/write-classifier.test.ts",
			"tests/extensions/quest-workflow/discipline.test.ts",
			"tests/extensions/quest-workflow/tree-gate.test.ts",
		],
	},
	{
		name: "Atomic, per-quest-locked writes",
		guards: ["tests/lib/quest/io.test.ts"],
	},
	{
		name: "Structural edits with dry-run and a reversible journal",
		guards: [
			"tests/lib/internal/quest/structural.test.ts",
			"tests/lib/internal/quest/structural-journal.test.ts",
			"tests/extensions/quest-workflow/reparent.test.ts",
		],
	},
	{
		name: "Create-from-URL seeding",
		guards: ["tests/lib/quest/url-fetchers.test.ts"],
	},
	{
		name: "Richness of the show projection",
		guards: [
			"tests/extensions/quest-workflow/render.test.ts",
			"tests/extensions/quest-workflow/render-rows.test.ts",
		],
	},
	{
		name: "Scaffold-versus-adopt tree split",
		guards: [
			"tests/extensions/quest-workflow/tree-adopt.test.ts",
			"tests/extensions/quest-workflow/tree-verbs.test.ts",
		],
	},
	{
		name: "Working-directory auto-load",
		guards: ["tests/extensions/quest-workflow/cwd-auto-attach.test.ts"],
	},
	{
		name: "Human-owned prose body",
		guards: [],
		waiver:
			"The body is free prose the author owns; prose-standard gates its voice, but no gate constrains its structure by design.",
	},
];

// Core verbs the rework must keep on the surface. Adding verbs is
// fine; dropping one of these is a regression that needs a decision.
const CORE_VERBS = [
	"create",
	"load",
	"show",
	"list",
	"focus",
	"think",
	"draft",
	"build",
	"conclude",
	"retire",
	"reopen",
	"reparent",
	"undo",
	"tree-add",
	"tree-adopt",
	"spawn-tab",
	"find",
	"who",
	"links",
];

describe("do-not-lose set", () => {
	it.each(DO_NOT_LOSE)("$name is guarded", (capability) => {
		if (capability.guards.length === 0) {
			expect(
				capability.waiver,
				`${capability.name} needs a waiver`,
			).toBeTruthy();
			return;
		}
		for (const guard of capability.guards) {
			const stat = statSync(join(repoRoot, guard));
			expect(stat.isFile(), `${guard} should be a file`).toBe(true);
			expect(stat.size, `${guard} should be non-empty`).toBeGreaterThan(0);
		}
	});

	it("keeps every core verb on the surface", () => {
		const surface: readonly string[] = QUEST_ACTIONS;
		for (const verb of CORE_VERBS) {
			expect(surface, `core verb ${verb} was dropped`).toContain(verb);
		}
	});
});
