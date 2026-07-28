/**
 * A capability nobody can find does not exist.
 *
 * The sibling gate checks that a parameter names the kinds that read
 * it. This checks the level above: that every kind these tools offer
 * is written down in the guide, which is what an agent reads when it
 * knows what it wants and not which verb provides it.
 *
 * The measurement that prompted it. One real accessibility audit
 * spent forty of its sixty-three browser_do calls on raw eval, and
 * four separate capabilities it needed were already shipping and went
 * unused: the viewport read it evaluated by hand, the tab order the
 * keyboard check already stores, the bulk style sweep behind query,
 * and the WCAG contrast maths it reimplemented twelve times. None of
 * that was a missing feature. All of it was a findability failure,
 * and nothing mechanical stopped a new kind from shipping
 * undiscoverable.
 *
 * It checks presence, not quality. Prose that mentions a kind while
 * explaining it badly passes, which is the right way for a gate like
 * this to be wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOOLS = ["see", "go", "do", "check"] as const;

const GUIDES = [
	"skills/browser-guide/SKILL.md",
	"skills/browser-accessibility-guide/SKILL.md",
] as const;

/**
 * Every kind literal the tool's schema offers.
 *
 * Scoped to the kind property's own union. Reading every literal in
 * the file swept up contrast levels and wait conditions and demanded
 * the guide document "AAA" as a kind, which is how this function
 * looked on its first run.
 */
function kindsOf(source: string): readonly string[] {
	const start = source.indexOf("\n\tkind: Type.");
	if (start < 0) return [];
	// The union's literals end at the first closing bracket after it,
	// which is the list they are written in.
	const listEnd = source.indexOf("\n\t\t\t],", start);
	const union = source.slice(start, listEnd < 0 ? undefined : listEnd);
	const found = new Set<string>();
	const literal = /Type\.Literal\("([a-zA-Z]+)"\)/g;
	let match: RegExpExecArray | null = literal.exec(union);
	for (; match !== null; match = literal.exec(union)) {
		const name = match[1];
		if (name) found.add(name);
	}
	return [...found];
}

function read(relative: string): string {
	return readFileSync(join(process.cwd(), relative), "utf8");
}

describe("every kind is written down somewhere", () => {
	const guides = GUIDES.map(read).join("\n");

	for (const tool of TOOLS) {
		it(`documents every kind browser_${tool} offers`, () => {
			const source = read(`extensions/browser-integration/${tool}.ts`);
			const kinds = kindsOf(source);
			// A tool with no kinds would make this vacuous, and one of
			// these growing a union is exactly when the gate matters.
			expect(kinds.length).toBeGreaterThan(0);

			const missing = kinds.filter(
				(kind) => !guides.includes(`kind:"${kind}"`),
			);

			expect(missing).toEqual([]);
		});
	}
});
