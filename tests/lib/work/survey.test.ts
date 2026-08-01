import { describe, expect, it } from "vitest";
import { surveyTarget } from "../../../lib/work/survey";

const held = [
	{ key: "world/fix-410", path: "/work/fix-410" },
	{ key: "world/spike", path: "/work/spike" },
];

/** A repo at /repo; everything under it is inside that working tree. */
const gitRootOf = (path: string) =>
	path === "/repo" || path.startsWith("/repo/") ? "/repo" : null;

describe("choosing what a survey looks at", () => {
	it("uses the only held tree when just one is held", () => {
		const out = surveyTarget({
			held: [held[0] as { key: string; path: string }],
			cwd: "/somewhere",
			gitRootOf,
		});

		expect(out).toMatchObject({ ok: true, key: "world/fix-410", held: true });
	});

	it("uses a held tree named outright", () => {
		const out = surveyTarget({
			tree: "world/spike",
			held,
			cwd: "/x",
			gitRootOf,
		});

		expect(out).toMatchObject({ ok: true, path: "/work/spike", held: true });
	});

	it("falls back to the checkout the caller is standing in", () => {
		// The main checkout is never broker-held, and it is the natural
		// place to ask what has been spent. Refusing there sent people to
		// raw git for a question this verb exists to answer.
		const out = surveyTarget({ held: [], cwd: "/repo/src", gitRootOf });

		expect(out).toMatchObject({ ok: true, path: "/repo", held: false });
	});

	it("names an unheld checkout by its path, not a tree key it does not have", () => {
		const out = surveyTarget({ held: [], cwd: "/repo/src", gitRootOf });

		expect(out.ok === true && out.key).toBe("/repo");
	});

	it("takes a path as the tree argument when it is not a held key", () => {
		const out = surveyTarget({ tree: "/repo/src", held, cwd: "/x", gitRootOf });

		expect(out).toMatchObject({ ok: true, path: "/repo", held: false });
	});

	it("prefers a held tree over the cwd when several are held", () => {
		// With several held and none named, the cwd is a real answer rather
		// than a guess between them, so it does not become a question.
		const out = surveyTarget({ held, cwd: "/repo/src", gitRootOf });

		expect(out).toMatchObject({ ok: true, path: "/repo", held: false });
	});

	it("asks which tree when several are held and the cwd is not a repo", () => {
		const out = surveyTarget({ held, cwd: "/nowhere", gitRootOf });

		expect(out.ok).toBe(false);
		expect(out.ok === false && out.refusal).toContain("world/spike");
	});

	it("refuses a name that is neither a held tree nor a checkout", () => {
		const out = surveyTarget({ tree: "typo", held, cwd: "/x", gitRootOf });

		expect(out.ok).toBe(false);
		expect(out.ok === false && out.refusal).toContain("typo");
	});

	it("names what is held when it refuses a typo", () => {
		// A typo should become a correction rather than a second guess.
		const out = surveyTarget({ tree: "typo", held, cwd: "/x", gitRootOf });

		expect(out.ok === false && out.refusal).toContain("world/fix-410");
	});

	it("refuses when nothing is held and the cwd is not a checkout", () => {
		const out = surveyTarget({ held: [], cwd: "/nowhere", gitRootOf });

		expect(out.ok).toBe(false);
	});
});
