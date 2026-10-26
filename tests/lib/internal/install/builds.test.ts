import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	packageName,
	skippedBuilds,
	unbuiltDependencies,
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

/** Put a package in pnpm's store folder, linked from the top, as pnpm lays it out. */
function placed(root: string, skipped: string, binding?: string): void {
	const name = packageName(skipped);
	const dir = join(
		root,
		"node_modules",
		".pnpm",
		skipped.replace("/", "+"),
		"node_modules",
		name,
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), "{}\n");
	if (binding !== undefined) {
		mkdirSync(join(dir, binding, ".."), { recursive: true });
		writeFileSync(join(dir, binding), "");
	}
	const link = join(root, "node_modules", name);
	mkdirSync(join(link, ".."), { recursive: true });
	symlinkSync(dir, link);
}

describe("unbuiltDependencies", () => {
	const record = "ignoredBuilds:\n  - sqlite3@6.0.1\n";

	it("names a skipped build with no binding", () => {
		const root = installed(record);
		placed(root, "sqlite3@6.0.1");
		expect(unbuiltDependencies(root)).toEqual(["sqlite3"]);
	});

	it("passes over a skipped build whose binding was built since", () => {
		// As on 26 October: pnpm recorded sqlite3 skipped at 12:14, its
		// script was run by hand at 12:28, and the record still said so.
		const root = installed(record);
		placed(root, "sqlite3@6.0.1", "build/Release/node_sqlite3.node");
		expect(unbuiltDependencies(root)).toEqual([]);
	});

	it("takes a fetched prebuild as a binding", () => {
		const root = installed("ignoredBuilds:\n  - '@scope/native@1.2.3'\n");
		placed(root, "@scope/native@1.2.3", "prebuilds/linux-x64/native.node");
		expect(unbuiltDependencies(root)).toEqual([]);
	});
});

describe("packageName", () => {
	it("drops the version, scoped or not", () => {
		expect(packageName("sqlite3@6.0.1")).toBe("sqlite3");
		expect(packageName("@scope/native@1.2.3")).toBe("@scope/native");
		expect(packageName("plain")).toBe("plain");
	});
});
