import { beforeEach, describe, expect, it } from "vitest";
import {
	defaultPlanDir,
	planFileName,
	resolvePlanDir,
	slugify,
} from "../../../extensions/plan-workflow/routing.js";
import { resetPlanRouters } from "../../../lib/internal/plan-routing/registry.js";
import { registerPlanRouter } from "../../../lib/plan-routing/index.js";

beforeEach(() => resetPlanRouters());

describe("slugify", () => {
	it("lowercases and hyphenates, collapsing runs of punctuation", () => {
		expect(slugify("A New Effort!")).toBe("a-new-effort");
		expect(slugify("  Plan: the Workflow / redesign  ")).toBe(
			"plan-the-workflow-redesign",
		);
	});

	it("returns empty for a title with no usable characters", () => {
		expect(slugify("!!!")).toBe("");
	});
});

describe("planFileName", () => {
	it("joins the stable id with a slug of the title", () => {
		expect(planFileName("PLAN-20260530-a3f", "A New Effort")).toBe(
			"PLAN-20260530-a3f-a-new-effort.md",
		);
	});

	it("falls back to just the id when the title has no slug", () => {
		expect(planFileName("PLAN-20260530-a3f", "!!!")).toBe(
			"PLAN-20260530-a3f.md",
		);
	});
});

describe("defaultPlanDir", () => {
	it("resolves to the main worktree root's .pi/plans, from the common git dir", () => {
		expect(defaultPlanDir("/repo/.git")).toBe("/repo/.pi/plans");
	});

	it("stays anchored to the main root even when called from a linked worktree", () => {
		// git rev-parse --git-common-dir returns the main .git for every
		// worktree, so a plan never lands inside a reapable worktree.
		expect(defaultPlanDir("/repo/.git")).toBe("/repo/.pi/plans");
	});
});

describe("resolvePlanDir", () => {
	const req = {
		id: "PLAN-20260530-a3f",
		title: "A New Effort",
		cwd: "/repo/.worktrees/plan-x",
		repoRoot: "/repo",
	};

	it("uses the durable fallback when no router is registered", async () => {
		expect(await resolvePlanDir(req, "/repo/.pi/plans")).toBe(
			"/repo/.pi/plans",
		);
	});

	it("lets a registered router redirect the destination", async () => {
		registerPlanRouter(() => "/Users/me/src/localhost/documents/plans");
		expect(await resolvePlanDir(req, "/repo/.pi/plans")).toBe(
			"/Users/me/src/localhost/documents/plans",
		);
	});

	it("falls back when a router defers by returning undefined", async () => {
		registerPlanRouter(() => undefined);
		expect(await resolvePlanDir(req, "/repo/.pi/plans")).toBe(
			"/repo/.pi/plans",
		);
	});

	it("takes the first router that returns a destination", async () => {
		registerPlanRouter(() => undefined);
		registerPlanRouter(() => "/first/win");
		registerPlanRouter(() => "/second");
		expect(await resolvePlanDir(req, "/repo/.pi/plans")).toBe("/first/win");
	});

	it("awaits an async router", async () => {
		registerPlanRouter(async () => "/async/dir");
		expect(await resolvePlanDir(req, "/repo/.pi/plans")).toBe("/async/dir");
	});
});
