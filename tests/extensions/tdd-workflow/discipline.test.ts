import { describe, expect, it } from "vitest";
import { disciplineFor } from "../../../extensions/tdd-workflow/discipline.js";

describe("disciplineFor", () => {
	it("holds planning to one increment of intent", () => {
		const d = disciplineFor("plan");
		expect(d).toMatch(/one increment/i);
		expect(d).toMatch(/intent|behaviour you want/i);
	});

	it("binds writing to the exported surface and reads friction as a design signal", () => {
		const d = disciplineFor("write");
		expect(d).toMatch(/exported surface/i);
		expect(d).toMatch(/internals/i);
		expect(d).toMatch(/hard to write|redesign/i);
	});

	it("demands a real assertion in red and a skeleton for the wrong red", () => {
		const d = disciplineFor("red");
		expect(d).toMatch(/assertion/i);
		expect(d).toMatch(/skeleton|stub/i);
	});

	it("keeps green to minimum code with the test left untouched", () => {
		const d = disciplineFor("green");
		expect(d).toMatch(/minimum/i);
		expect(d).toMatch(/do not touch the test/i);
	});

	it("turns refactor toward the internal and external design", () => {
		const d = disciplineFor("refactor");
		expect(d).toMatch(/internal and external/i);
		expect(d).toMatch(/tests stay green|behaviour/i);
	});

	it("notes that no loop is active when idle", () => {
		expect(disciplineFor("idle")).toMatch(/no loop|when you're ready/i);
	});
});
