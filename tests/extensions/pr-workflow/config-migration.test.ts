import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadPrWorkflowConfig,
	PR_WORKFLOW_SLUG,
} from "../../../extensions/pr-workflow/config";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "prwf-migrate-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("PR_WORKFLOW_SLUG", () => {
	it("is the section key in the package config", () => {
		expect(PR_WORKFLOW_SLUG).toBe("pr-workflow");
	});
});

describe("loadPrWorkflowConfig unified migration", () => {
	it("reads reviewers from the package config pr-workflow section", async () => {
		const packagePath = join(dir, "config.json");
		await writeFile(
			packagePath,
			JSON.stringify({
				version: 1,
				sections: { "pr-workflow": { reviewers: [{ id: "alice" }] } },
			}),
		);
		const legacyPath = join(dir, "pr-workflow.json");

		const result = await loadPrWorkflowConfig(legacyPath, packagePath);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.config.path).toBe(packagePath);
		expect(result.config.defaults.reviewers).toEqual([{ id: "alice" }]);
	});

	it("falls back to the legacy file when the section is absent", async () => {
		const packagePath = join(dir, "config.json");
		await writeFile(packagePath, JSON.stringify({ version: 1, sections: {} }));
		const legacyPath = join(dir, "pr-workflow.json");
		await writeFile(
			legacyPath,
			JSON.stringify({ reviewers: [{ id: "legacy" }] }),
		);

		const result = await loadPrWorkflowConfig(legacyPath, packagePath);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.config.path).toBe(legacyPath);
		expect(result.config.defaults.reviewers).toEqual([{ id: "legacy" }]);
	});

	it("reports the package path when an invalid section is present", async () => {
		const packagePath = join(dir, "config.json");
		await writeFile(
			packagePath,
			JSON.stringify({
				version: 1,
				sections: { "pr-workflow": { reviewers: [] } },
			}),
		);
		const legacyPath = join(dir, "pr-workflow.json");

		const result = await loadPrWorkflowConfig(legacyPath, packagePath);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.path).toBe(packagePath);
	});
});
