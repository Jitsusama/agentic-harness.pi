import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	resolveQuestsRoot,
	summarizeQuestConfig,
} from "../../../extensions/quest-workflow/config";

describe("parseQuestWorkflowConfig", () => {
	it("defaults an absent section to empty config", () => {
		expect(parseQuestWorkflowConfig(undefined)).toEqual({
			ok: true,
			value: {},
		});
	});

	it("accepts a questsRoot string", () => {
		expect(parseQuestWorkflowConfig({ questsRoot: "/quests" })).toEqual({
			ok: true,
			value: { questsRoot: "/quests" },
		});
	});

	it("treats an empty object as empty config", () => {
		expect(parseQuestWorkflowConfig({})).toEqual({ ok: true, value: {} });
	});

	it("rejects a non-object section", () => {
		const result = parseQuestWorkflowConfig(42);
		expect(result.ok).toBe(false);
	});

	it("rejects a non-string questsRoot", () => {
		const result = parseQuestWorkflowConfig({ questsRoot: 7 });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/questsRoot/);
	});
});

describe("resolveQuestsRoot", () => {
	it("uses the configured questsRoot when set", () => {
		expect(resolveQuestsRoot({ questsRoot: "/custom" }, "/data")).toBe(
			"/custom",
		);
	});

	it("falls back to quests under the data dir", () => {
		expect(resolveQuestsRoot({}, "/data")).toBe(join("/data", "quests"));
	});
});

describe("summarizeQuestConfig", () => {
	it("marks a configured questsRoot as sourced from config", () => {
		const summary = summarizeQuestConfig({
			config: { questsRoot: "/custom" },
			configPath: "/cfg/config.json",
			dataDir: "/data",
		});
		expect(summary).toEqual({
			configPath: "/cfg/config.json",
			questsRoot: "/custom",
			questsRootSource: "config",
		});
	});

	it("marks a defaulted questsRoot as sourced from default", () => {
		const summary = summarizeQuestConfig({
			config: {},
			configPath: "/cfg/config.json",
			dataDir: "/data",
		});
		expect(summary.questsRootSource).toBe("default");
		expect(summary.questsRoot).toBe(join("/data", "quests"));
	});
});

describe("QUEST_WORKFLOW_SLUG", () => {
	it("is the section key for this extension", () => {
		expect(QUEST_WORKFLOW_SLUG).toBe("quest-workflow");
	});
});
