/**
 * A pi reloaded onto a tree says so in the file it said its version in.
 * The reload points pi's settings at the tree, so no install can be found
 * from either; left alone, the file went on naming the version the pi had
 * left, which pi-packages and the host's rollout gate both believe.
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
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	PACKAGE_NAME,
	PACKAGE_ROOT,
	tellPiPackages,
} from "../../../extensions/reload-workflow/lifecycle.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";

/** Where the process keeps the file it said, as lifecycle.ts names it. */
const SAID_FILE = Symbol.for("agentic-harness.reload.said-file");

let root: string;
let before: unknown;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "said-onto-tree-"));
	before = Reflect.get(globalThis, SAID_FILE);
});
afterEach(() => {
	Reflect.set(globalThis, SAID_FILE, before);
	rmSync(root, { recursive: true, force: true });
});

it("rewrites the file it said in before with the tree it now runs", () => {
	const tree = join(root, "tree");
	mkdirSync(tree);
	writeFileSync(
		join(tree, "package.json"),
		JSON.stringify({ name: PACKAGE_NAME }),
	);
	// During a reload onto a tree, the settings' entry names the tree.
	const settings: PackageSettings = {
		read: () => [tree],
		write: async () => {},
		rootOf: () => tree,
	};
	const file = join(root, "package", "loaded", String(process.pid));
	mkdirSync(join(root, "package", "loaded"), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ root: "/versions/left" })}\n`);
	Reflect.set(globalThis, SAID_FILE, file);

	tellPiPackages(settings);

	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
		root: PACKAGE_ROOT,
	});
});
