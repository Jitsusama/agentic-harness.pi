import { describe, expect, it } from "vitest";
import { disciplineFor } from "../../../extensions/plan-workflow/discipline.js";
import type { Stage } from "../../../extensions/plan-workflow/machine.js";

const STAGES: Stage[] = [
	"idle",
	"think",
	"plan",
	"build",
	"concluded",
	"retired",
];

describe("disciplineFor", () => {
	it("gives non-empty guidance for every stage", () => {
		for (const s of STAGES) {
			expect(disciplineFor(s).length).toBeGreaterThan(0);
		}
	});

	it("makes think read-only and about debate, not interrogation", () => {
		const t = disciplineFor("think");
		expect(t).toMatch(/read-only/i);
		expect(t).toMatch(/debate|push back|alternativ/i);
	});

	it("limits plan-stage writes to the document", () => {
		expect(disciplineFor("plan")).toMatch(/document/i);
	});

	it("makes build keep the plan current and gate only spirit changes on consent", () => {
		const b = disciplineFor("build");
		expect(b).toMatch(/consent/i);
		expect(b).toMatch(/current|check off|log/i);
	});

	it("keeps idle non-coercive", () => {
		expect(disciplineFor("idle")).not.toMatch(/\b(must|always|never)\b/i);
	});
});
