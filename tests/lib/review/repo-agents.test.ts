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
		const found = discoverAgents([
			{
				path: ".claude/agents/code-reviewer.md",
				text: agent(
					"name: code-reviewer\ndescription: Reviews Rust for token efficiency",
					"You are an elite Rust reviewer.",
				),
			},
		]);

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

	it("takes the prose and leaves the mechanism, saying which", () => {
		// Measured on disk: 13 of 15 carry tools and 6 carry a model, and
		// both are another harness's vocabulary. `sonnet` is not a model
		// pi resolves and `Bash, Read, Edit` are not tools it has, so
		// adopting either sends words pi cannot act on. The lens is the
		// part that transfers.
		const found = discoverAgents([
			{
				path: ".claude/agents/debugger.md",
				text: agent(
					"name: debugger\ndescription: Finds the cause\nmodel: sonnet\ntools: Bash, Read, Edit",
				),
			},
		]);

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
		const found = discoverAgents([
			{ path: ".claude/agents/broken.md", text: "no frontmatter here" },
			{
				path: ".claude/agents/architect.md",
				text: agent("name: architect\ndescription: Reads the seams"),
			},
		]);

		expect(found.agents.map((one) => one.id)).toEqual(["repo:architect"]);
		expect(found.skipped).toHaveLength(1);
		expect(found.skipped[0]?.path).toBe(".claude/agents/broken.md");
		expect(found.skipped[0]?.why).toContain("frontmatter");
	});

	it("refuses two files that would answer to the same name", () => {
		// The id has to identify one lens. Two files claiming it is a
		// repo problem rather than a caller's, so both are dropped and
		// named: picking one would make which lens ran depend on
		// directory order.
		const found = discoverAgents([
			{
				path: ".claude/agents/owl.md",
				text: agent("name: owl\ndescription: One"),
			},
			{
				path: "agents/owl.md",
				text: agent("name: owl\ndescription: Another"),
			},
		]);

		expect(found.agents).toEqual([]);
		expect(found.skipped.map((one) => one.path)).toEqual([
			".claude/agents/owl.md",
			"agents/owl.md",
		]);
		expect(found.skipped[0]?.why).toContain("owl");
	});
});
