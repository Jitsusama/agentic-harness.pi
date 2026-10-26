import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectPackageManager,
	findProject,
} from "../../../lib/core/verify/project.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "verify-project-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
	it("maps each lockfile to its manager and defaults to npm", () => {
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

		// No lockfile at all (e.g. a freshly scaffolded project before
		// its first install) must default to npm, not pnpm: npm ships
		// with Node, so it is the one manager guaranteed to exist.
		const bareDir = mkdtempSync(join(tmpdir(), "verify-bare-"));
		expect(detectPackageManager(bareDir)).toBe("npm");
		rmSync(bareDir, { recursive: true, force: true });
	});

	it("prefers an explicit packageManager field over any lockfile", () => {
		writeFileSync(join(dir, "yarn.lock"), "");
		expect(detectPackageManager(dir, "pnpm@8.10.0")).toBe("pnpm");
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
