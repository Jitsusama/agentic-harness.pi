import { describe, expect, it } from "vitest";
import { schemaActions } from "./schema-actions.ts";

describe("the actions a tool's schema offers", () => {
	it("reads a union of literals", () => {
		expect(
			schemaActions(
				`action: Type.Union([Type.Literal("see"), Type.Literal("say")], {`,
			),
		).toEqual(["see", "say"]);
	});

	it("reads a string enum given its list inline", () => {
		expect(
			schemaActions(
				`action: StringEnum(\n\t["propose", "merge"] as const,\n\t{ description: "propose: put it up" },\n),\nlabelMode: StringEnum(["add", "set"] as const)`,
			),
		).toEqual(["propose", "merge"]);
	});

	it("reads a string enum given a list named above the tool", () => {
		expect(
			schemaActions(
				`const LABEL_MODES = ["add", "set"] as const;\nconst WORK_ACTIONS = [\n\t"tree",\n\t"push",\n] as const;\naction: Type.Optional(\n\tStringEnum(WORK_ACTIONS, { description: "tree: cut one" }),\n),`,
			),
		).toEqual(["tree", "push"]);
	});

	it("finds nothing where no action is declared", () => {
		expect(schemaActions("name: Type.String()")).toEqual([]);
	});
});
