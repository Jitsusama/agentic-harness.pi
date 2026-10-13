/**
 * Pointing pi's entry for a package at a tree and back, through pi's own
 * settings writer, in an agent dir of the test's own.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installRoot,
	type PackageSettings,
	piPackageSettings,
	pointEntryAt,
} from "../../../../lib/internal/reload/settings.ts";

const NAME = "agentic-harness.pi";
const GIT_SOURCE = "git:github.com/Jitsusama/agentic-harness.pi";

let dir: string;
let agentDir: string;
let tree: string;
let settings: PackageSettings;

function packageAt(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
}

function onDisk(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reload-settings-"));
	agentDir = join(dir, "agent");
	tree = join(dir, "tree");
	packageAt(join(agentDir, "git", "github.com", "Jitsusama", NAME), NAME);
	packageAt(tree, NAME);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultModel: "opus",
			packages: ["npm:other", GIT_SOURCE],
		}),
	);
	settings = piPackageSettings(agentDir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("pointing the package's entry at a tree", () => {
	it("finds where the settings install the package", () => {
		expect(installRoot(settings, NAME)).toBe(
			join(agentDir, "git", "github.com", "Jitsusama", NAME),
		);
	});

	it("replaces the install's entry in place, and puts it back", async () => {
		const restore = await pointEntryAt(settings, NAME, tree);
		expect(onDisk().packages).toEqual(["npm:other", tree]);

		expect(await restore()).toBe(true);
		expect(onDisk().packages).toEqual(["npm:other", GIT_SOURCE]);
	});

	it("leaves every other setting as it was", async () => {
		const restore = await pointEntryAt(settings, NAME, tree);
		await restore();
		expect(onDisk().defaultModel).toBe("opus");
	});

	it("keeps an entry's filters on the tree", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [{ source: GIT_SOURCE, skills: [] }],
			}),
		);
		const restore = await pointEntryAt(settings, NAME, tree);
		expect(onDisk().packages).toEqual([{ source: tree, skills: [] }]);
		await restore();
		expect(onDisk().packages).toEqual([{ source: GIT_SOURCE, skills: [] }]);
	});

	it("keeps a model chosen while the tree was in", async () => {
		const restore = await pointEntryAt(settings, NAME, tree);
		const changed = { ...onDisk(), defaultModel: "sonnet" };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(changed));

		await restore();
		expect(onDisk()).toMatchObject({
			defaultModel: "sonnet",
			packages: ["npm:other", GIT_SOURCE],
		});
	});

	it("says so, and touches nothing, when the entry changed under it", async () => {
		const restore = await pointEntryAt(settings, NAME, tree);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:other"] }),
		);

		expect(await restore()).toBe(false);
		expect(onDisk().packages).toEqual(["npm:other"]);
	});

	it("refuses a directory that is not the package", async () => {
		const elsewhere = join(dir, "elsewhere");
		packageAt(elsewhere, "something-else");
		await expect(pointEntryAt(settings, NAME, elsewhere)).rejects.toThrow(
			/not a checkout of agentic-harness\.pi/,
		);
		expect(onDisk().packages).toEqual(["npm:other", GIT_SOURCE]);
	});

	it("refuses, naming -e, when the settings have no entry for the package", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:other"] }),
		);
		await expect(pointEntryAt(settings, NAME, tree)).rejects.toThrow(/-e /);
	});
});
