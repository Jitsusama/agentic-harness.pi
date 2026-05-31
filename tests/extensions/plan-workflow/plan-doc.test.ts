import { describe, expect, it } from "vitest";
import {
	extractTitle,
	formatPlanId,
	type PlanDoc,
	parsePlan,
	progress,
	revise,
	scaffold,
	serializePlan,
} from "../../../extensions/plan-workflow/plan-doc.js";

const SAMPLE = `---
id: PLAN-20260530-a3f
stage: think
updated: 2026-05-30
sessions:
  - 019e7a4b-516e-7911-a1ff-6d5383f7fa64
---

# Plan Workflow Redesign

## Spirit
Make planning feel like a conversation.

## Work
- [x] map the system
- [ ] build the machine
`;

describe("formatPlanId", () => {
	it("builds PLAN-YYYYMMDD-suffix with a zero-padded month and day", () => {
		expect(formatPlanId(new Date(2026, 4, 30), "a3f")).toBe(
			"PLAN-20260530-a3f",
		);
		expect(formatPlanId(new Date(2026, 0, 5), "9zz")).toBe("PLAN-20260105-9zz");
	});
});

describe("parsePlan", () => {
	it("reads the front-matter floor and keeps the body", () => {
		const doc = parsePlan(SAMPLE);
		expect(doc).not.toBeNull();
		expect(doc?.frontMatter).toEqual({
			id: "PLAN-20260530-a3f",
			stage: "think",
			updated: "2026-05-30",
			sessions: ["019e7a4b-516e-7911-a1ff-6d5383f7fa64"],
		});
		expect(doc?.body).toContain("# Plan Workflow Redesign");
		expect(doc?.body).toContain("## Spirit");
	});

	it("reads an inline sessions list too", () => {
		const doc = parsePlan(
			"---\nid: PLAN-20260530-a3f\nstage: build\nupdated: 2026-05-31\nsessions: [s1, s2]\n---\nbody",
		);
		expect(doc?.frontMatter.sessions).toEqual(["s1", "s2"]);
		expect(doc?.frontMatter.stage).toBe("build");
	});

	it("treats a missing or empty sessions list as none", () => {
		const doc = parsePlan(
			"---\nid: PLAN-20260530-a3f\nstage: think\nupdated: 2026-05-31\nsessions: []\n---\nbody",
		);
		expect(doc?.frontMatter.sessions).toEqual([]);
	});

	it("returns null when there is no front-matter", () => {
		expect(parsePlan("# just a markdown file\n")).toBeNull();
	});
});

describe("serializePlan", () => {
	it("round-trips through parse without loss", () => {
		const doc = parsePlan(SAMPLE) as PlanDoc;
		const reparsed = parsePlan(serializePlan(doc));
		expect(reparsed).toEqual(doc);
	});

	it("emits the keys in a stable order", () => {
		const doc = parsePlan(SAMPLE) as PlanDoc;
		const out = serializePlan(doc);
		expect(out.indexOf("id:")).toBeLessThan(out.indexOf("stage:"));
		expect(out.indexOf("stage:")).toBeLessThan(out.indexOf("updated:"));
		expect(out.indexOf("updated:")).toBeLessThan(out.indexOf("sessions:"));
	});
});

describe("extractTitle", () => {
	it("reads the first H1 as the title", () => {
		expect(extractTitle("# Hello World\n\n## Spirit\n")).toBe("Hello World");
	});

	it("ignores deeper headings and returns null when there is no H1", () => {
		expect(extractTitle("## Sub\nbody\n")).toBeNull();
	});
});

describe("progress", () => {
	it("counts GitHub task-list checkboxes, done and total", () => {
		expect(progress("- [x] a\n- [ ] b\n- [X] c\nplain text\n")).toEqual({
			total: 3,
			done: 2,
		});
	});

	it("ignores non-checkbox bullets", () => {
		expect(progress("- a\n* b\n1. c\n")).toEqual({ total: 0, done: 0 });
	});
});

describe("revise", () => {
	const base = parsePlan(SAMPLE) as PlanDoc;

	it("sets the stage", () => {
		expect(revise(base, { stage: "build" }).frontMatter.stage).toBe("build");
	});

	it("stamps the updated date from a Date", () => {
		expect(
			revise(base, { date: new Date(2026, 5, 1) }).frontMatter.updated,
		).toBe("2026-06-01");
	});

	it("adds a session without duplicating", () => {
		const once = revise(base, { session: "new-session" });
		expect(once.frontMatter.sessions).toContain("new-session");
		const twice = revise(once, { session: "new-session" });
		expect(twice.frontMatter.sessions).toEqual(once.frontMatter.sessions);
	});

	it("leaves the body untouched", () => {
		expect(revise(base, { stage: "plan" }).body).toBe(base.body);
	});
});

describe("scaffold", () => {
	it("produces a parseable plan with the recommended sections", () => {
		const text = scaffold({
			id: "PLAN-20260530-a3f",
			title: "A New Effort",
			stage: "think",
			updated: "2026-05-30",
			sessions: ["s1"],
		});
		const doc = parsePlan(text);
		expect(doc?.frontMatter).toEqual({
			id: "PLAN-20260530-a3f",
			stage: "think",
			updated: "2026-05-30",
			sessions: ["s1"],
		});
		expect(doc?.body).toContain("# A New Effort");
		expect(doc?.body).toContain("## Spirit");
		expect(doc?.body).toContain("## Discovery & Deviations");
		expect(doc?.body).toContain("- [ ]");
	});

	it("defaults sessions to empty", () => {
		const doc = parsePlan(
			scaffold({
				id: "PLAN-20260530-a3f",
				title: "x",
				stage: "think",
				updated: "2026-05-30",
			}),
		);
		expect(doc?.frontMatter.sessions).toEqual([]);
	});
});
