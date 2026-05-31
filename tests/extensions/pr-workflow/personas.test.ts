import { describe, expect, it } from "vitest";
import { parsePersona } from "../../../extensions/pr-workflow/personas.js";

const PERSONA = `---
name: Privilege Escalation Hunter
description: Reads every diff as a path to higher privilege.
---
You hunt for privilege escalation. Assume the author is a careful
engineer who nonetheless left one door unlocked. Trace every new
capability to who can reach it.
`;

describe("parsePersona", () => {
	it("splits frontmatter identity from the charter body", () => {
		const result = parsePersona("escalation", PERSONA);
		if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
		expect(result.persona.id).toBe("escalation");
		expect(result.persona.name).toBe("Privilege Escalation Hunter");
		expect(result.persona.description).toBe(
			"Reads every diff as a path to higher privilege.",
		);
		expect(result.persona.charter).toContain("You hunt for privilege");
		expect(result.persona.charter).toContain("one door unlocked");
		// The charter is the body only — no frontmatter bleed.
		expect(result.persona.charter).not.toContain("---");
		expect(result.persona.charter).not.toContain("name:");
	});

	it("rejects a document with no frontmatter fence", () => {
		const result = parsePersona("x", "just a charter, no fence");
		expect(result.ok).toBe(false);
	});

	it("rejects an unterminated frontmatter block", () => {
		const result = parsePersona("x", "---\nname: A\ndescription: b\nbody");
		expect(result.ok).toBe(false);
	});

	it("rejects frontmatter missing name or description", () => {
		expect(parsePersona("x", "---\ndescription: b\n---\nbody").ok).toBe(false);
		expect(parsePersona("x", "---\nname: A\n---\nbody").ok).toBe(false);
	});

	it("rejects an empty charter body", () => {
		const result = parsePersona("x", "---\nname: A\ndescription: b\n---\n  \n");
		expect(result.ok).toBe(false);
	});
});
