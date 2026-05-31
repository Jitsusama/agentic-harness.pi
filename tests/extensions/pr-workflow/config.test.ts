import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadPrWorkflowConfig,
	parsePrWorkflowConfig,
	prWorkflowConfigPath,
} from "../../../extensions/pr-workflow/config.js";

const tempDirs: string[] = [];

async function tempFile(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pr-workflow-config-"));
	tempDirs.push(dir);
	return join(dir, name);
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("prWorkflowConfigPath", () => {
	it("prefers PR_WORKFLOW_CONFIG when set", () => {
		expect(
			prWorkflowConfigPath(
				{ PR_WORKFLOW_CONFIG: "/tmp/custom.json", XDG_CONFIG_HOME: "/tmp/xdg" },
				"/home/user",
			),
		).toBe("/tmp/custom.json");
	});

	it("uses XDG_CONFIG_HOME before the home fallback", () => {
		expect(
			prWorkflowConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/user"),
		).toBe("/tmp/xdg/pi/pr-workflow.json");
	});
});

describe("parsePrWorkflowConfig", () => {
	it("parses reviewer and judge defaults without built-in fallbacks", () => {
		const result = parsePrWorkflowConfig({
			reviewers: [
				{
					id: "fast",
					model: "anthropic/claude-sonnet-4-5",
					thinkingLevel: "low",
					tools: ["read", "bash"],
				},
			],
			judge: { id: "judge", model: "anthropic/claude-opus-4-7" },
		});

		expect(result).toEqual({
			ok: true,
			defaults: {
				reviewers: [
					{
						id: "fast",
						model: "anthropic/claude-sonnet-4-5",
						thinkingLevel: "low",
						tools: ["read", "bash"],
					},
				],
				judge: { id: "judge", model: "anthropic/claude-opus-4-7" },
			},
		});
	});

	it("derives the reviewer id from persona when id is omitted", () => {
		const result = parsePrWorkflowConfig({
			reviewers: [{ persona: "escalation", model: "anthropic/x" }],
		});
		if (!result.ok) throw new Error(result.error);
		const reviewer = result.defaults.reviewers?.[0];
		expect(reviewer?.id).toBe("escalation");
		expect(reviewer?.persona).toBe("escalation");
	});

	it("keeps id and persona distinct when both are given", () => {
		const result = parsePrWorkflowConfig({
			reviewers: [
				{ id: "escalation-fast", persona: "escalation", model: "a" },
				{ id: "escalation-deep", persona: "escalation", model: "b" },
			],
		});
		if (!result.ok) throw new Error(result.error);
		const reviewers = result.defaults.reviewers ?? [];
		// Same persona, two distinct reviewer ids: no collision.
		expect(reviewers.map((r) => r.id)).toEqual([
			"escalation-fast",
			"escalation-deep",
		]);
		expect(reviewers.every((r) => r.persona === "escalation")).toBe(true);
	});

	it("still accepts an id-only reviewer with no persona", () => {
		const result = parsePrWorkflowConfig({ reviewers: [{ id: "plain" }] });
		if (!result.ok) throw new Error(result.error);
		const reviewer = result.defaults.reviewers?.[0];
		expect(reviewer?.id).toBe("plain");
		expect(reviewer?.persona).toBeUndefined();
	});

	it("rejects a reviewer with neither id nor persona", () => {
		const result = parsePrWorkflowConfig({ reviewers: [{ model: "a" }] });
		expect(result.ok).toBe(false);
	});

	it("rejects an empty config instead of inventing defaults", () => {
		const result = parsePrWorkflowConfig({});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toMatch(/define reviewers, judge, or both/i);
	});

	it("rejects duplicate reviewer ids", () => {
		const result = parsePrWorkflowConfig({
			reviewers: [{ id: "fast" }, { id: "fast" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/duplicate reviewer id/i);
	});

	it("rejects a judge id that duplicates a council reviewer", () => {
		const result = parsePrWorkflowConfig({
			reviewers: [{ id: "judge" }],
			judge: { id: "judge" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/judge id duplicates/i);
	});

	it("rejects unknown thinking levels", () => {
		const result = parsePrWorkflowConfig({
			reviewers: [{ id: "fast", thinkingLevel: "maximum" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/thinkingLevel/i);
	});

	it("accepts the full pi thinking-level set", () => {
		for (const level of [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		] as const) {
			const result = parsePrWorkflowConfig({
				reviewers: [{ id: "fast", thinkingLevel: level }],
			});
			expect(result.ok, `level ${level} should parse`).toBe(true);
		}
	});
});

describe("loadPrWorkflowConfig", () => {
	it("loads config JSON from disk", async () => {
		const path = await tempFile("pr-workflow.json");
		await writeFile(
			path,
			JSON.stringify({ reviewers: [{ id: "fast" }], judge: { id: "judge" } }),
			"utf8",
		);

		const result = await loadPrWorkflowConfig(path);

		expect(result).toEqual({
			ok: true,
			config: {
				path,
				defaults: {
					reviewers: [{ id: "fast" }],
					judge: { id: "judge" },
				},
			},
		});
	});

	it("returns a clear error when the config file is missing", async () => {
		const path = await tempFile("missing.json");
		const result = await loadPrWorkflowConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toMatch(/No pr-workflow config found/i);
	});
});
