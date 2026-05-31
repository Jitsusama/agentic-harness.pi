import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyTransition,
	hydrateFromDoc,
	persist,
	restore,
	syncFromDoc,
	updateScoreboard,
} from "../../../extensions/plan-workflow/lifecycle.js";
import { createPlanState } from "../../../extensions/plan-workflow/state.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

interface Captured {
	status?: string;
	widget?: string[];
	widgetCalls?: number;
}

function makeCtx(
	entries: unknown[],
	cwd: string,
	captured: Captured,
): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "sess-1",
		},
		ui: {
			theme: fakeTheme(),
			setStatus: (_key: string, value?: string) => {
				captured.status = value;
			},
			setWidget: (_key: string, value?: string[]) => {
				captured.widget = value;
				captured.widgetCalls = (captured.widgetCalls ?? 0) + 1;
			},
		},
	} as unknown as ExtensionContext;
}

function makeApi(entries: unknown[]): ExtensionAPI {
	return {
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
		// createDoc probes git to resolve a plans dir; fail the probe so
		// it falls back to the cwd-based plans dir under the tmp root.
		exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
	} as unknown as ExtensionAPI;
}

const PLAN_AT_BUILD = `---
id: PLAN-20260530-a3f
stage: build
updated: 2026-05-30
sessions: []
---
# Title Here

## Work
- [x] done one
- [ ] still open
`;

describe("hydrateFromDoc", () => {
	it("reads the stage, id, title and checkbox progress", () => {
		expect(hydrateFromDoc(PLAN_AT_BUILD)).toEqual({
			stage: "build",
			planId: "PLAN-20260530-a3f",
			title: "Title Here",
			done: 1,
			total: 2,
		});
	});

	it("returns null for text without front-matter", () => {
		expect(hydrateFromDoc("# just markdown")).toBeNull();
	});
});

describe("restore", () => {
	it("lets the document win over the cached stage", () => {
		const file = path.join(tmp, "p.md");
		fs.writeFileSync(file, PLAN_AT_BUILD);
		const entries = [
			{
				type: "custom",
				customType: "plan-workflow",
				data: { planPath: file, stage: "think" }, // stale cache
			},
		];
		const captured: Captured = {};
		const state = createPlanState();

		restore(state, makeApi([]), makeCtx(entries, tmp, captured));

		expect(state.stage).toBe("build"); // doc wins, not the cached "think"
		expect(state.title).toBe("Title Here");
		expect(state.total).toBe(2);
		expect(captured.status).toBeDefined();
	});

	it("drops to idle when the restored plan is already concluded", () => {
		const file = path.join(tmp, "done.md");
		fs.writeFileSync(
			file,
			`---\nid: PLAN-20260530-don\nstage: concluded\nupdated: 2026-05-30\nsessions: []\n---\n# Done Work\n`,
		);
		const entries = [
			{
				type: "custom",
				customType: "plan-workflow",
				data: { planPath: file, stage: "concluded" },
			},
		];
		const captured: Captured = { widgetCalls: 0 };
		const state = createPlanState();
		restore(state, makeApi([]), makeCtx(entries, tmp, captured));
		expect(state.stage).toBe("idle");
		expect(state.planPath).toBeNull();
		expect(captured.status).toBeUndefined();
	});

	it("drops to idle when the document has vanished", () => {
		const entries = [
			{
				type: "custom",
				customType: "plan-workflow",
				data: { planPath: path.join(tmp, "gone.md"), stage: "build" },
			},
		];
		const state = createPlanState();
		restore(state, makeApi([]), makeCtx(entries, tmp, {}));
		expect(state.stage).toBe("idle");
		expect(state.planPath).toBeNull();
	});

	it("rests at idle when nothing is persisted", () => {
		const state = createPlanState();
		restore(state, makeApi([]), makeCtx([], tmp, {}));
		expect(state.stage).toBe("idle");
	});
});

describe("persist", () => {
	it("writes only the pointer, not the whole plan", () => {
		const entries: unknown[] = [];
		const state = createPlanState();
		state.planPath = "/repo/.pi/plans/p.md";
		state.stage = "plan";
		persist(state, makeApi(entries));
		expect(entries).toEqual([
			{
				type: "custom",
				customType: "plan-workflow",
				data: { planPath: "/repo/.pi/plans/p.md", stage: "plan" },
			},
		]);
	});
});

describe("syncFromDoc", () => {
	it("repaints when a checkbox edit changes the progress", () => {
		const file = path.join(tmp, "p.md");
		fs.writeFileSync(file, PLAN_AT_BUILD); // 1 of 2 checked
		const captured: Captured = { widgetCalls: 0 };
		const state = createPlanState();
		state.stage = "build";
		state.planPath = file;
		state.planId = "PLAN-20260530-a3f";
		state.title = "Title Here";
		state.done = 1;
		state.total = 2;

		fs.writeFileSync(
			file,
			PLAN_AT_BUILD.replace("- [ ] still open", "- [x] still open"),
		);
		syncFromDoc(state, makeCtx([], tmp, captured));

		expect(state.done).toBe(2);
		expect(captured.widgetCalls).toBe(1);
	});

	it("does not repaint when nothing changed", () => {
		const file = path.join(tmp, "p.md");
		fs.writeFileSync(file, PLAN_AT_BUILD);
		const captured: Captured = { widgetCalls: 0 };
		const state = createPlanState();
		state.stage = "build";
		state.planPath = file;
		state.planId = "PLAN-20260530-a3f";
		state.title = "Title Here";
		state.done = 1;
		state.total = 2;

		syncFromDoc(state, makeCtx([], tmp, captured));
		expect(captured.widgetCalls).toBe(0);
	});
});

describe("updateScoreboard", () => {
	it("paints nothing at idle", () => {
		const captured: Captured = { widgetCalls: 0 };
		updateScoreboard(createPlanState(), makeCtx([], tmp, captured));
		expect(captured.status).toBeUndefined();
		expect(captured.widget).toBeUndefined();
	});

	it("paints the status and widget while active", () => {
		const captured: Captured = { widgetCalls: 0 };
		const state = createPlanState();
		state.stage = "build";
		state.title = "Workflow";
		state.done = 1;
		state.total = 3;
		updateScoreboard(state, makeCtx([], tmp, captured));
		expect(captured.status).toBeDefined();
		expect(captured.widget).toBeDefined();
	});

	it("clears the board for a terminal stage, like idle", () => {
		for (const stage of ["concluded", "retired"] as const) {
			const captured: Captured = { widgetCalls: 0 };
			const state = createPlanState();
			state.stage = stage;
			state.title = "Finished Work";
			state.done = 3;
			state.total = 3;
			updateScoreboard(state, makeCtx([], tmp, captured));
			expect(captured.status).toBeUndefined();
			expect(captured.widget).toBeUndefined();
		}
	});
});

describe("applyTransition", () => {
	it("refuses an illegal move without touching disk or git", async () => {
		const result = await applyTransition(
			createPlanState(),
			makeApi([]),
			makeCtx([], tmp, {}),
			{ action: "draft" }, // draft from idle is illegal
		);
		expect(result.ok).toBe(false);
	});

	it("opens thinking from idle and paints the board", async () => {
		const captured: Captured = {};
		const state = createPlanState();
		const result = await applyTransition(
			state,
			makeApi([]),
			makeCtx([], tmp, captured),
			{ action: "think", note: "redesign the plan workflow" },
		);
		expect(result.ok).toBe(true);
		expect(state.stage).toBe("think");
		expect(captured.status).toBeDefined();
	});

	it("starts a fresh plan when thinking after a terminal stage", async () => {
		const file = path.join(tmp, "old.md");
		fs.writeFileSync(
			file,
			`---\nid: PLAN-20260530-old\nstage: concluded\nupdated: 2026-05-30\nsessions: []\n---\n# Old Plan\n`,
		);
		const state = createPlanState();
		state.stage = "concluded";
		state.planPath = file;
		state.planId = "PLAN-20260530-old";

		const result = await applyTransition(
			state,
			makeApi([]),
			makeCtx([], tmp, {}),
			{ action: "think", note: "a brand new effort" },
		);

		expect(result.ok).toBe(true);
		expect(state.stage).toBe("think");
		expect(state.planPath).toBeNull();
		expect(state.planId).toBeNull();
		// The concluded document is left untouched, not revived to think.
		expect(fs.readFileSync(file, "utf-8")).toContain("stage: concluded");
	});

	// PB1: replanning an active plan (think -> draft again) must rewrite
	// the existing document, not fork a duplicate with a new id.
	it("resumes the active plan on draft instead of forking a new one", async () => {
		const state = createPlanState();
		const api = makeApi([]);
		const ctx = makeCtx([], tmp, {});

		await applyTransition(state, api, ctx, {
			action: "think",
			note: "first pass",
		});
		await applyTransition(state, api, ctx, {
			action: "draft",
			title: "Original Plan",
		});
		const originalPath = state.planPath;
		const originalId = state.planId;
		expect(originalPath).not.toBeNull();

		// Replan: go back to think (keeps the active plan), then draft again.
		await applyTransition(state, api, ctx, {
			action: "think",
			note: "reconsider",
		});
		await applyTransition(state, api, ctx, {
			action: "draft",
			title: "Original Plan",
		});

		// Same document, same id: no fork.
		expect(state.planPath).toBe(originalPath);
		expect(state.planId).toBe(originalId);
		// Exactly one plan file exists in the plans dir.
		const planDir = path.dirname(originalPath as string);
		const planFiles = fs.readdirSync(planDir).filter((f) => f.endsWith(".md"));
		expect(planFiles).toHaveLength(1);
	});

	// PB2: a transition must not carry a deleted plan pointer forward.
	it("resets to idle when the tracked plan file has vanished mid-session", async () => {
		const state = createPlanState();
		const api = makeApi([]);
		const ctx = makeCtx([], tmp, {});

		await applyTransition(state, api, ctx, {
			action: "think",
			note: "start",
		});
		await applyTransition(state, api, ctx, {
			action: "draft",
			title: "Doomed Plan",
		});
		const planPath = state.planPath as string;
		expect(planPath).not.toBeNull();

		// The document disappears out from under the tool.
		fs.rmSync(planPath);

		// Next transition must not act on the dead pointer; it rests at idle.
		const result = await applyTransition(state, api, ctx, {
			action: "build",
		});
		expect(result.ok).toBe(false);
		expect(state.planPath).toBeNull();
		expect(state.stage).toBe("idle");
	});
});
