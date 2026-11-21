/**
 * The fence a spawn tells the node it runs in: the spawn's word, then
 * its quest's, then strict, with nothing inferred and no typo read as a
 * fence (ISXEG8 [8c12af57]).
 */
import { describe, expect, it } from "vitest";
import {
	declarationSaid,
	FENCE_TESTS,
	fenceDeclared,
	sandboxFor,
	UNDECLARED,
} from "../../../../lib/internal/fence/fence-declaration.ts";

describe("the fence a spawn declares", () => {
	it("is strict, declared by nobody, when neither the spawn nor its quest names one", () => {
		expect(
			fenceDeclared(undefined, undefined),
			"nothing declared reads strict",
		).toEqual({ ok: true, declaration: { kind: "strict", from: "default" } });
		expect(
			fenceDeclared("  ", undefined),
			"a blank word declares nothing",
		).toEqual({ ok: true, declaration: UNDECLARED });
	});

	it("is the spawn's word over its quest's", () => {
		expect(fenceDeclared("strict", "fence"), "the spawn's strict wins").toEqual(
			{ ok: true, declaration: { kind: "strict", from: "spawn" } },
		);
		expect(
			fenceDeclared(" fence ", "strict"),
			"the spawn's fence wins",
		).toEqual({ ok: true, declaration: { kind: "fence", from: "spawn" } });
	});

	it("is its quest's word when the spawn names none", () => {
		expect(fenceDeclared(undefined, "fence"), "the quest's fence").toEqual({
			ok: true,
			declaration: { kind: "fence", from: "quest" },
		});
	});

	it("refuses a word that names no fence a spawn may declare, saying the two tests", () => {
		for (const word of ["none", "Fence", "unfenced", "off"]) {
			const read = fenceDeclared(word, undefined);
			expect(read.ok, `${word} is refused`).toBe(false);
			expect(
				!read.ok && read.refusal,
				`${word}'s refusal says the tests`,
			).toContain(FENCE_TESTS);
		}
	});

	it("refuses a quest whose README names no such fence, rather than reading it as one", () => {
		for (const said of ["none", 1, ["fence"]]) {
			const read = fenceDeclared(undefined, said);
			expect(read.ok, `${JSON.stringify(said)} is refused`).toBe(false);
			expect(
				!read.ok && read.refusal,
				"the refusal says how to set it",
			).toContain("need-add");
		}
	});
});

describe("the sandbox a spawned session is given", () => {
	it("is the kind declared, by the spawn or its quest", () => {
		expect(
			sandboxFor({ kind: "fence", from: "spawn" }),
			"a spawn's fence",
		).toBe("fence");
		expect(
			sandboxFor({ kind: "strict", from: "quest" }),
			"a quest's strict",
		).toBe("strict");
	});

	it("is nothing when nobody declared one, so the stage decides as before", () => {
		expect(sandboxFor(UNDECLARED), "undeclared sets no sandbox").toBe(
			undefined,
		);
	});
});

describe("the declaration said", () => {
	it("names the kind and who declared it", () => {
		expect(declarationSaid({ kind: "fence", from: "spawn" })).toBe(
			"It tells the node it runs fence, as the spawn declared.",
		);
		expect(declarationSaid(UNDECLARED)).toBe(
			"It tells the node it runs strict, since nothing declared a fence.",
		);
	});
});
