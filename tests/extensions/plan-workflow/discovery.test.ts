import { describe, expect, it } from "vitest";
import {
	isPlanHead,
	type PlanSummary,
	shouldDescend,
	sortPlans,
	summarizePlan,
} from "../../../extensions/plan-workflow/discovery.js";

function row(id: string, updated: string): PlanSummary {
	return {
		id,
		title: id,
		stage: "build",
		updated,
		done: 0,
		total: 0,
		fileName: `${id}.md`,
	};
}

const PLAN_TEXT = [
	"---",
	"id: PLAN-20260530-ksz",
	"stage: build",
	"updated: 2026-05-30",
	"sessions: []",
	"---",
	"# Discover Plans",
	"",
	"## Work",
	"- [x] First core",
	"- [ ] Second core",
	"- [ ] Third core",
].join("\n");

describe("shouldDescend", () => {
	it("descends into an ordinary directory", () => {
		expect(shouldDescend("projects")).toBe(true);
		expect(shouldDescend("gsd-49736")).toBe(true);
	});

	it("skips any dot directory", () => {
		expect(shouldDescend(".git")).toBe(false);
		expect(shouldDescend(".worktrees")).toBe(false);
		expect(shouldDescend(".pi")).toBe(false);
	});

	it("skips known heavy vendor directories", () => {
		expect(shouldDescend("node_modules")).toBe(false);
		expect(shouldDescend("vendor")).toBe(false);
		expect(shouldDescend("bower_components")).toBe(false);
	});
});

describe("isPlanHead", () => {
	it("accepts a head with a PLAN- id inside the front-matter", () => {
		const head = ["---", "id: PLAN-20260530-ksz", "stage: build", "---"].join(
			"\n",
		);
		expect(isPlanHead(head)).toBe(true);
	});

	it("rejects a markdown file with no front-matter", () => {
		expect(isPlanHead("# Just a heading\n\nSome prose.")).toBe(false);
	});

	it("rejects front-matter whose id is not a plan id", () => {
		const head = ["---", "id: mastery-2026-q2", "title: Notes", "---"].join(
			"\n",
		);
		expect(isPlanHead(head)).toBe(false);
	});

	it("requires the PLAN- id before the closing fence", () => {
		const head = ["---", "title: Notes", "---", "id: PLAN-20260530-ksz"].join(
			"\n",
		);
		expect(isPlanHead(head)).toBe(false);
	});
});

describe("summarizePlan", () => {
	it("summarizes a plan with front-matter, title and progress", () => {
		const summary = summarizePlan("PLAN-20260530-ksz-discover.md", PLAN_TEXT);
		expect(summary).toEqual({
			id: "PLAN-20260530-ksz",
			title: "Discover Plans",
			stage: "build",
			updated: "2026-05-30",
			done: 1,
			total: 3,
			fileName: "PLAN-20260530-ksz-discover.md",
		});
	});

	it("returns null for a markdown file that is not a plan", () => {
		expect(summarizePlan("notes.md", "# Notes\n\nNo front-matter.")).toBeNull();
	});

	it("returns null when the id is not a plan id", () => {
		const text = [
			"---",
			"id: mastery-q2",
			"stage: build",
			"updated: x",
			"---",
		].join("\n");
		expect(summarizePlan("mastery.md", text)).toBeNull();
	});

	it("falls back to null title when the body has no H1", () => {
		const text = [
			"---",
			"id: PLAN-20260530-abc",
			"stage: think",
			"updated: 2026-05-30",
			"sessions: []",
			"---",
			"No heading here.",
		].join("\n");
		expect(summarizePlan("p.md", text)?.title).toBeNull();
	});
});

describe("sortPlans", () => {
	it("orders newest updated first", () => {
		const sorted = sortPlans([
			row("PLAN-20260501-aaa", "2026-05-01"),
			row("PLAN-20260530-bbb", "2026-05-30"),
			row("PLAN-20260515-ccc", "2026-05-15"),
		]);
		expect(sorted.map((s) => s.updated)).toEqual([
			"2026-05-30",
			"2026-05-15",
			"2026-05-01",
		]);
	});

	it("breaks ties on the same date by id descending", () => {
		const sorted = sortPlans([
			row("PLAN-20260530-aaa", "2026-05-30"),
			row("PLAN-20260530-zzz", "2026-05-30"),
		]);
		expect(sorted.map((s) => s.id)).toEqual([
			"PLAN-20260530-zzz",
			"PLAN-20260530-aaa",
		]);
	});

	it("does not mutate the input array", () => {
		const input = [
			row("PLAN-20260501-aaa", "2026-05-01"),
			row("PLAN-20260530-bbb", "2026-05-30"),
		];
		const before = input.map((s) => s.id);
		sortPlans(input);
		expect(input.map((s) => s.id)).toEqual(before);
	});
});
