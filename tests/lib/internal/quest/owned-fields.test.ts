import { describe, expect, it } from "vitest";
import {
	applyEdits,
	ownedFieldChanges,
} from "../../../../lib/internal/quest/owned-fields";

const PLAN =
	"---\nid: PLAN-1\nkind: plan\nquest: QEST-1\nstage: build\n---\n# Plan\n\n- [ ] item\n";

describe("owned front matter fields", () => {
	it("names a stage changed by hand, with the verbs that change it", () => {
		const changes = ownedFieldChanges(
			"document",
			PLAN,
			PLAN.replace("stage: build", "stage: concluded"),
		);
		expect(changes).toEqual([
			expect.objectContaining({
				field: "stage",
				from: "build",
				to: "concluded",
				verb: expect.stringContaining("`conclude`"),
			}),
		]);
	});

	it("lets the body and unowned fields change", () => {
		const after = PLAN.replace("- [ ] item", "- [x] item").replace(
			"stage: build",
			"stage: build\ntags: [a]",
		);
		expect(ownedFieldChanges("document", PLAN, after)).toEqual([]);
	});

	it("reads a quoted value as the same value", () => {
		const after = PLAN.replace("stage: build", 'stage: "build"');
		expect(ownedFieldChanges("document", PLAN, after)).toEqual([]);
	});

	it("names a quest status changed by hand", () => {
		const readme = "---\nid: QEST-1\nkind: quest\nstatus: active\n---\n# Q\n";
		const changes = ownedFieldChanges(
			"readme",
			readme,
			readme.replace("status: active", "status: concluded"),
		);
		expect(changes.map((c) => c.field)).toEqual(["status"]);
	});

	it("counts dropping a field as changing it", () => {
		const changes = ownedFieldChanges("document", PLAN, "# Plan\n");
		expect(changes.map((c) => c.field)).toEqual([
			"id",
			"kind",
			"quest",
			"stage",
		]);
	});
});

describe("applying an edit call", () => {
	it("applies each replacement as the edit tool would", () => {
		expect(
			applyEdits("a b c", [
				{ oldText: "a", newText: "x" },
				{ oldText: "c", newText: "z" },
			]),
		).toBe("x b z");
	});

	it("gives up where the edit tool would refuse", () => {
		expect(applyEdits("a a", [{ oldText: "a", newText: "x" }])).toBeUndefined();
		expect(applyEdits("a", [{ oldText: "b", newText: "x" }])).toBeUndefined();
	});
});
