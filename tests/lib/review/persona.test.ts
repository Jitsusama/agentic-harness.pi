import { describe, expect, it } from "vitest";
import type { Roster } from "../../../lib/review/index.js";
import { bindPersonas, parsePersona } from "../../../lib/review/index.js";

const file = (
	over: { name?: string; description?: string; body?: string } = {},
) =>
	[
		"---",
		`name: ${over.name ?? "Security Reviewer"}`,
		`description: ${over.description ?? "Reads for what an attacker would reach for"}`,
		"---",
		"",
		over.body ?? "Assume the input is hostile. Trust nothing the caller sends.",
	].join("\n");

describe("reading a persona file", () => {
	it("takes its identity from the frontmatter and its charter from the body", () => {
		const parsed = parsePersona("security", file());

		expect(parsed).toEqual({
			persona: {
				id: "security",
				name: "Security Reviewer",
				description: "Reads for what an attacker would reach for",
				charter: "Assume the input is hostile. Trust nothing the caller sends.",
			},
		});
	});

	it("takes the id from the caller, not the file", () => {
		// The file name is the id, because two files cannot share a name
		// and nothing inside a file can enforce that.
		const parsed = parsePersona(
			"my-own-name",
			file({ name: "Something Else" }),
		);

		expect("persona" in parsed && parsed.persona.id).toBe("my-own-name");
	});

	it("refuses a file with no frontmatter", () => {
		const parsed = parsePersona("x", "just some prose");

		expect("refusal" in parsed && parsed.refusal).toMatch(/frontmatter/i);
	});

	it("refuses a persona with no name", () => {
		const parsed = parsePersona("x", file({ name: "" }));

		expect("refusal" in parsed && parsed.refusal).toMatch(/name/i);
	});

	it("refuses a persona with no description", () => {
		const parsed = parsePersona("x", file({ description: "" }));

		expect("refusal" in parsed && parsed.refusal).toMatch(/description/i);
	});

	it("refuses a persona with an empty charter", () => {
		// A persona with no charter is a name for a lens that does not
		// exist, which is worse than no persona at all.
		const parsed = parsePersona("x", file({ body: "   " }));

		expect("refusal" in parsed && parsed.refusal).toMatch(/charter|empty/i);
	});

	it("names the persona it could not read", () => {
		const parsed = parsePersona("security", "no frontmatter here");

		expect("refusal" in parsed && parsed.refusal).toContain("security");
	});
});

describe("binding a roster to its personas", () => {
	const lookup = (id: string) =>
		id === "security" ? "Assume the input is hostile." : undefined;

	it("gives a participant the charter its persona names", () => {
		const roster: Roster = {
			reviewers: [{ id: "security", persona: "security", model: "opus" }],
		};

		const bound = bindPersonas(roster, lookup);

		expect("bindings" in bound && bound.bindings).toEqual([
			{
				participant: { id: "security", persona: "security", model: "opus" },
				charter: "Assume the input is hostile.",
			},
		]);
	});

	it("leaves a participant with no persona unshaped", () => {
		const roster: Roster = { reviewers: [{ id: "wren", model: "opus" }] };

		const bound = bindPersonas(roster, lookup);

		expect("bindings" in bound && bound.bindings).toEqual([
			{ participant: { id: "wren", model: "opus" } },
		]);
	});

	it("refuses when a named persona is missing", () => {
		// The whole reason this refuses rather than falling back: a
		// reviewer that was meant to be a security lens and silently
		// became a generic one still files findings under the name
		// "security", and a reader weighs them as a specialist's.
		const roster: Roster = {
			reviewers: [{ id: "sec", persona: "nowhere", model: "opus" }],
		};

		const bound = bindPersonas(roster, lookup);

		expect("refusal" in bound && bound.refusal).toContain("nowhere");
	});

	it("names the participant whose persona is missing", () => {
		const roster: Roster = {
			reviewers: [
				{ id: "security", persona: "security" },
				{ id: "perf", persona: "performance" },
			],
		};

		const bound = bindPersonas(roster, lookup);

		expect("refusal" in bound && bound.refusal).toContain("perf");
	});

	it("binds the judge as well as the reviewers", () => {
		const roster: Roster = {
			reviewers: [{ id: "wren" }],
			judge: { id: "arbiter", persona: "security" },
		};

		const bound = bindPersonas(roster, lookup);

		expect("bindings" in bound && bound.bindings).toHaveLength(2);
		expect("bindings" in bound && bound.bindings[1]?.charter).toBe(
			"Assume the input is hostile.",
		);
	});

	it("refuses on a judge's missing persona too", () => {
		const roster: Roster = {
			reviewers: [{ id: "wren" }],
			judge: { id: "arbiter", persona: "gone" },
		};

		const bound = bindPersonas(roster, lookup);

		expect("refusal" in bound && bound.refusal).toContain("arbiter");
	});
});
