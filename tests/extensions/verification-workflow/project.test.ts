import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectPackageManager,
	findProject,
	truncate,
} from "../../../extensions/verification-workflow/index.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "verify-project-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
	it("maps each lockfile to its manager and defaults to pnpm", () => {
		writeFileSync(join(dir, "pnpm-lock.yaml"), "");
		expect(detectPackageManager(dir)).toBe("pnpm");

		const yarnDir = mkdtempSync(join(tmpdir(), "verify-yarn-"));
		writeFileSync(join(yarnDir, "yarn.lock"), "");
		expect(detectPackageManager(yarnDir)).toBe("yarn");
		rmSync(yarnDir, { recursive: true, force: true });

		const npmDir = mkdtempSync(join(tmpdir(), "verify-npm-"));
		writeFileSync(join(npmDir, "package-lock.json"), "{}");
		expect(detectPackageManager(npmDir)).toBe("npm");
		rmSync(npmDir, { recursive: true, force: true });

		const bareDir = mkdtempSync(join(tmpdir(), "verify-bare-"));
		expect(detectPackageManager(bareDir)).toBe("pnpm");
		rmSync(bareDir, { recursive: true, force: true });
	});
});

describe("findProject", () => {
	it("reads the package.json in the start directory", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { check: "biome" } }),
		);

		const project = findProject(dir);

		expect(project?.dir).toBe(dir);
		expect(project?.scripts.check).toBe("biome");
	});

	it("walks up to a parent package.json", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
		const deep = join(dir, "packages", "inner");
		mkdirSync(deep, { recursive: true });

		expect(findProject(deep)?.dir).toBe(dir);
	});

	it("returns null on a malformed package.json", () => {
		writeFileSync(join(dir, "package.json"), "{ not valid json");

		expect(findProject(dir)).toBeNull();
	});
});

describe("truncate", () => {
	it("returns short output trimmed and untouched", () => {
		expect(truncate("a\nb\nc")).toBe("a\nb\nc");
	});

	it("keeps only the tail when the output runs long", () => {
		const output = Array.from({ length: 250 }, (_, i) => `line ${i}`).join(
			"\n",
		);

		const result = truncate(output, 200);

		expect(result).toContain("50 earlier lines omitted");
		expect(result).toContain("line 249");
		expect(result).not.toContain("line 49\n");
	});
});
