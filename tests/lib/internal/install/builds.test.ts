import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	packageName,
	skippedBuilds,
} from "../../../../lib/internal/install/builds.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function installed(record?: string): string {
	const root = mkdtempSync(join(tmpdir(), "builds-"));
	dirs.push(root);
	if (record !== undefined) {
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", ".modules.yaml"), record);
	}
	return root;
}

describe("skippedBuilds", () => {
	it("names each build pnpm recorded as skipped", () => {
		const root = installed(
			"ignoredBuilds:\n  - sqlite3@6.0.1\n  - '@scope/native@1.2.3'\npendingBuilds: []\n",
		);
		expect(skippedBuilds(root)).toEqual([
			"sqlite3@6.0.1",
			"@scope/native@1.2.3",
		]);
	});

	it("names none when every build ran", () => {
		expect(skippedBuilds(installed("pendingBuilds: []\n"))).toEqual([]);
	});

	it("names none where nothing was installed", () => {
		expect(skippedBuilds(installed())).toEqual([]);
	});

	it("names none from a record that does not parse", () => {
		expect(skippedBuilds(installed("ignoredBuilds: [\n"))).toEqual([]);
	});
});

describe("packageName", () => {
	it("drops the version, scoped or not", () => {
		expect(packageName("sqlite3@6.0.1")).toBe("sqlite3");
		expect(packageName("@scope/native@1.2.3")).toBe("@scope/native");
		expect(packageName("plain")).toBe("plain");
	});
});
