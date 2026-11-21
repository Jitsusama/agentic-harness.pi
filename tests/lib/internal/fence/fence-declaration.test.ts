/**
 * The fence a spawn tells the node it runs in: the spawn's word, then
 * its quest's, then what it truly runs, with nothing inferred and no
 * typo read as a fence (ISXEG8 [8c12af57], [8d401568]).
 */
import { describe, expect, it } from "vitest";
import {
	declarationSaid,
	declarationSettled,
	FENCE_TESTS,
	fenceDeclared,
	sandboxFor,
	undeclaredRuns,
} from "../../../../lib/internal/fence/fence-declaration.ts";

describe("the fence a spawn declares", () => {
	it("is what it runs, declared by nobody, when neither the spawn nor its quest names one", () => {
		expect(
			fenceDeclared(undefined, undefined, "none"),
			"nothing declared says what it runs",
		).toEqual({ ok: true, declaration: { kind: "none", from: "default" } });
		expect(
			fenceDeclared("  ", undefined, "fence"),
			"a blank word declares nothing",
		).toEqual({ ok: true, declaration: { kind: "fence", from: "default" } });
	});

	it("is the spawn's word over its quest's", () => {
		expect(
			fenceDeclared("strict", "fence", "none"),
			"the spawn's strict wins",
		).toEqual({ ok: true, declaration: { kind: "strict", from: "spawn" } });
		expect(
			fenceDeclared(" fence ", "strict", "strict"),
			"the spawn's fence wins, even under a strict parent",
		).toEqual({ ok: true, declaration: { kind: "fence", from: "spawn" } });
	});

	it("is its quest's word when the spawn names none", () => {
		expect(
			fenceDeclared(undefined, "fence", "strict"),
			"the quest's fence",
		).toEqual({ ok: true, declaration: { kind: "fence", from: "quest" } });
	});

	it("refuses a word that names no fence a spawn may declare, saying the two tests", () => {
		for (const word of ["none", "Fence", "unfenced", "off"]) {
			const read = fenceDeclared(word, undefined, "none");
			expect(read.ok, `${word} is refused`).toBe(false);
			expect(
				!read.ok && read.refusal,
				`${word}'s refusal says the tests`,
			).toContain(FENCE_TESTS);
		}
	});

	it("refuses a quest whose README names no such fence, rather than reading it as one", () => {
		for (const said of ["none", 1, ["fence"]]) {
			const read = fenceDeclared(undefined, said, "none");
			expect(read.ok, `${JSON.stringify(said)} is refused`).toBe(false);
			expect(
				!read.ok && read.refusal,
				"the refusal says how to set it",
			).toContain("need-add");
		}
	});
});

describe("what a spawn nobody declared a fence for runs", () => {
	it("is strict under a strict parent, staged or not", () => {
		for (const staged of [true, false]) {
			expect(
				undeclaredRuns({ parent: { PI_SANDBOX: " strict " }, staged }),
				`a strict parent's child, staged ${staged}`,
			).toBe("strict");
		}
	});

	it("is the fence where the first stage takes it, and none otherwise", () => {
		expect(
			undeclaredRuns({ parent: { PI_SANDBOX: "fence" }, staged: true }),
			"staged",
		).toBe("fence");
		expect(undeclaredRuns({ parent: {}, staged: false }), "unstaged").toBe(
			"none",
		);
		expect(
			undeclaredRuns({ parent: { PI_SANDBOX: "fence" }, staged: false }),
			"a fenced parent hands nothing on",
		).toBe("none");
	});
});

describe("the declaration once the spawn has started", () => {
	const staged = { kind: "fence", from: "default" } as const;

	const fresh = {
		staged: true,
		carried: true,
		reopens: false,
		pi: true,
		kept: true,
	};
	const unfenced = { kind: "none", from: "default" };

	it("is unfenced for an undeclared fence the stage didn't take, or whose token nothing carries", () => {
		expect(
			declarationSettled(staged, { ...fresh, staged: false }),
			"unlisted",
		).toEqual(unfenced);
		expect(
			declarationSettled(staged, { ...fresh, carried: false }),
			"a held start carries no token",
		).toEqual(unfenced);
	});

	it("is unfenced for a reopen, whatever was declared, since a reopen is given no sandbox", () => {
		for (const declared of [
			{ kind: "fence", from: "spawn" },
			{ kind: "strict", from: "quest" },
			{ kind: "strict", from: "default" },
			staged,
		] as const) {
			expect(
				declarationSettled(declared, { ...fresh, reopens: true }),
				`a reopen declared ${declared.kind} from ${declared.from}`,
			).toEqual(unfenced);
		}
	});

	it("is unfenced for a command that isn't pi, which reads none of the fence's variables", () => {
		for (const declared of [
			{ kind: "fence", from: "spawn" },
			{ kind: "strict", from: "quest" },
			{ kind: "strict", from: "default" },
			staged,
		] as const) {
			expect(
				declarationSettled(declared, { ...fresh, pi: false }),
				`a command declared ${declared.kind} from ${declared.from}`,
			).toEqual(unfenced);
		}
	});

	it("is unfenced for a declared fence whose mark didn't reach it, which its pi lifts", () => {
		const declared = { kind: "fence", from: "spawn" } as const;
		expect(
			declarationSettled(declared, { ...fresh, kept: false }),
			"an older host dropped the mark",
		).toEqual(unfenced);
		const strict = { kind: "strict", from: "spawn" } as const;
		expect(
			declarationSettled(strict, { ...fresh, kept: false }),
			"strict is never lifted, mark or not",
		).toEqual(strict);
	});

	it("is unchanged for one staged and carried, or one declared", () => {
		expect(declarationSettled(staged, fresh), "staged and carried").toEqual(
			staged,
		);
		const neither = {
			staged: false,
			carried: false,
			reopens: false,
			pi: true,
			kept: true,
		};
		const declared = { kind: "fence", from: "quest" } as const;
		expect(
			declarationSettled(declared, neither),
			"a declared fence stands",
		).toEqual(declared);
		const strict = { kind: "strict", from: "default" } as const;
		expect(
			declarationSettled(strict, neither),
			"a strict parent's child stays strict",
		).toEqual(strict);
	});
});

describe("the sandbox a fresh spawned session is given", () => {
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

	it("is strict for an undeclared child of a strict parent, which nothing else hands on", () => {
		expect(
			sandboxFor({ kind: "strict", from: "default" }),
			"a strict parent's child",
		).toBe("strict");
	});

	it("is nothing for any other undeclared child, so the stage decides as before", () => {
		for (const kind of ["fence", "none"] as const) {
			expect(
				sandboxFor({ kind, from: "default" }),
				`undeclared ${kind} sets no sandbox`,
			).toBe(undefined);
		}
	});
});

describe("the declaration said", () => {
	it("names what it runs and who declared it", () => {
		expect(
			declarationSaid({ kind: "fence", from: "spawn" }),
			"a spawn's fence",
		).toBe("It runs fence, as the spawn declared.");
		expect(
			declarationSaid({ kind: "none", from: "default" }),
			"nothing declared, unfenced",
		).toBe("It runs unfenced, declared by nobody.");
	});
});
