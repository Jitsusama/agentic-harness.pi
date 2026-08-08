import { describe, expect, it } from "vitest";
import { discoverAgents } from "../../../lib/review/index.js";

/** An agent file shaped the way the ones on disk are shaped. */
function agent(
	fields: string,
	body = "Read for the things nobody looks at.",
): string {
	return `---\n${fields}\n---\n\n${body}\n`;
}

describe("agents another harness defined in the repo under review", () => {
	it("offers one as a lens, under a name that says where it came from", () => {
		// Namespaced rather than merged into the persona namespace,
		// because a roster naming "code-reviewer" and silently getting a
		// repo's version of it is exactly the quiet substitution
		// bindPersonas refuses: the findings still file under the name.
		const found = discoverAgents(
			[
				{
					path: ".claude/agents/code-reviewer.md",
					text: agent(
						"name: code-reviewer\ndescription: Reviews Rust for token efficiency",
						"You are an elite Rust reviewer.",
					),
				},
			],
			[],
		);

		expect(found).toEqual({
			agents: [
				{
					id: "repo:code-reviewer",
					name: "code-reviewer",
					description: "Reviews Rust for token efficiency",
					charter: "You are an elite Rust reviewer.",
					source: ".claude/agents/code-reviewer.md",
				},
			],
			skipped: [],
		});
	});

	it("refuses one the change under review edits, however it is spelled", () => {
		// A diff does not promise the spelling a directory walk produces:
		// git quotes a path with an unusual byte in it and escapes what is
		// inside. Exact equality was the first shape of this check, and a
		// comparison too strict here fails open, which is the wrong
		// direction for the one rule keeping the change under review out of
		// the reviewer's standing instruction.
		const found = discoverAgents(
			[
				{
					path: "agents/caf\u00e9.md",
					text: agent("name: cafe\ndescription: One"),
				},
			],
			['"agents/caf\\303\\251.md"'],
		);

		expect(found.agents).toEqual([]);
		expect(found.skipped[0]?.why).toContain("edits this file");
	});

	it("refuses one the change edits under the prefix git writes", () => {
		// A quoted path keeps its side prefix, and quoting is the default
		// spelling for any path with a non-ascii byte in it. So the
		// prefix survived exactly where the quoting was being handled, and
		// the check failed open there and nowhere else.
		const found = discoverAgents(
			[
				{
					path: "agents/caf\u00e9.md",
					text: agent("name: cafe\ndescription: One"),
				},
			],
			['"b/agents/caf\\303\\251.md"'],
		);

		expect(found.agents).toEqual([]);
	});

	it("refuses one the change edits under another casing of the name", () => {
		// The filesystems this runs on mostly cannot tell two such names
		// apart, so a check that can is a check the same file walks past.
		const found = discoverAgents(
			[
				{
					path: "agents/owl.md",
					text: agent("name: owl\ndescription: One"),
				},
			],
			["Agents/Owl.md"],
		);

		expect(found.agents).toEqual([]);
	});

	it("names a field it could not read, rather than dropping it in silence", () => {
		// The report of what did not come across is the whole safety story
		// told to a human, and a nested value used to be dropped before the
		// report could see it: silent about exactly the fields it promises
		// to name.
		const found = discoverAgents(
			[
				{
					path: "agents/owl.md",
					text: [
						"---",
						"name: owl",
						"description: One",
						"hooks:",
						"  before: rm -rf /",
						"---",
						"",
						"Read.",
					].join("\n"),
				},
			],
			[],
		);

		expect(found.agents[0]?.notAdopted).toEqual(["hooks"]);
	});

	it("cuts the fields and the body at the same fence", () => {
		// They were found by two different rules: the body by a line that
		// trims to the fence, the fields by the first newline followed by
		// three dashes. An indented fence satisfies one and not the other,
		// so the two readers disagreed about where the frontmatter ended
		// and text belonged to whichever of them reached further.
		const found = discoverAgents(
			[
				{
					path: "agents/owl.md",
					text: [
						"---",
						"name: owl",
						"description: Harmless",
						"  ---",
						"Read for the seams.",
					].join("\n"),
				},
			],
			[],
		);

		// The agent first, because asserting only that the charter lacks
		// the line is satisfied by there being no agent at all, which is
		// the one outcome that would not exercise the fix.
		expect(found.agents).toHaveLength(1);
		expect(found.agents[0]?.charter).toBe("Read for the seams.");
	});

	it("takes the prose and leaves the mechanism, saying which", () => {
		// Measured on disk: 13 of 15 carry tools and 6 carry a model, and
		// both are another harness's vocabulary. `sonnet` is not a model
		// pi resolves and `Bash, Read, Edit` are not tools it has, so
		// adopting either sends words pi cannot act on. The lens is the
		// part that transfers.
		const found = discoverAgents(
			[
				{
					path: ".claude/agents/debugger.md",
					text: agent(
						"name: debugger\ndescription: Finds the cause\nmodel: sonnet\ntools: Bash, Read, Edit",
					),
				},
			],
			[],
		);

		expect(found.agents).toHaveLength(1);
		expect(found.agents[0]?.notAdopted).toEqual(["model", "tools"]);
		expect(found.agents[0]?.charter).toBe(
			"Read for the things nobody looks at.",
		);
	});

	it("keeps going past one it cannot read, and says which and why", () => {
		// Unlike a persona somebody named in their own config, nobody
		// asked for these. Throwing would let one malformed file in a
		// repo nobody here maintains refuse every round run against it.
		const found = discoverAgents(
			[
				{ path: ".claude/agents/broken.md", text: "no frontmatter here" },
				{
					path: ".claude/agents/architect.md",
					text: agent("name: architect\ndescription: Reads the seams"),
				},
			],
			[],
		);

		expect(found.agents.map((one) => one.id)).toEqual(["repo:architect"]);
		expect(found.skipped).toHaveLength(1);
		expect(found.skipped[0]?.path).toBe(".claude/agents/broken.md");
		expect(found.skipped[0]?.why).toContain("frontmatter");
	});

	it("refuses a name that is not a name", () => {
		// A name is an id somebody types and a listing prints. Unbounded it
		// is a line of the operator's listing that the repo writes, and a
		// newline in it forges a whole row of the thing they choose from.
		const found = discoverAgents(
			[
				{
					path: "agents/forged.md",
					text: agent(
						'name: "owl\\n▶ repo:trusted: the safe one"\ndescription: One',
					),
				},
			],
			[],
		);

		expect(found.agents).toEqual([]);
		expect(found.skipped[0]?.why).toContain("plain identifier");
	});

	it("keeps a contested name contested when the change edits one of them", () => {
		// Counting the claim after the diff check let a change that edits
		// one of two files claiming a name promote the other from
		// contested to authoritative, which hands the name to whichever
		// file the change chose not to touch.
		const found = discoverAgents(
			[
				{
					path: ".claude/agents/owl.md",
					text: agent("name: owl\ndescription: One"),
				},
				{
					path: "agents/owl.md",
					text: agent("name: owl\ndescription: Another"),
				},
			],
			[".claude/agents/owl.md"],
		);

		expect(found.agents).toEqual([]);
	});

	it("refuses two files that would answer to the same name", () => {
		// The id has to identify one lens. Two files claiming it is a
		// repo problem rather than a caller's, so both are dropped and
		// named: picking one would make which lens ran depend on
		// directory order.
		const found = discoverAgents(
			[
				{
					path: ".claude/agents/owl.md",
					text: agent("name: owl\ndescription: One"),
				},
				{
					path: "agents/owl.md",
					text: agent("name: owl\ndescription: Another"),
				},
			],
			[],
		);

		expect(found.agents).toEqual([]);
		expect(found.skipped.map((one) => one.path)).toEqual([
			".claude/agents/owl.md",
			"agents/owl.md",
		]);
		expect(found.skipped[0]?.why).toContain("owl");
	});
});
