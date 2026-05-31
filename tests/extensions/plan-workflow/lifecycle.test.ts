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
			},
		},
	} as unknown as ExtensionContext;
}

function makeApi(entries: unknown[]): ExtensionAPI {
	return {
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
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

describe("updateScoreboard", () => {
	it("paints nothing at idle", () => {
		const captured: Captured = {};
		updateScoreboard(createPlanState(), makeCtx([], tmp, captured));
		expect(captured.status).toBeUndefined();
		expect(captured.widget).toBeUndefined();
	});

	it("paints the status and widget while active", () => {
		const captured: Captured = {};
		const state = createPlanState();
		state.stage = "build";
		state.title = "Workflow";
		state.done = 1;
		state.total = 3;
		updateScoreboard(state, makeCtx([], tmp, captured));
		expect(captured.status).toBeDefined();
		expect(captured.widget).toBeDefined();
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
});
