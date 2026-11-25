/**
 * What the unit lane's setup files load, the sandbox and the fence
 * modules it runs among them, loads no mesh transport. A transport
 * loaded by a setup file binds the real file system before a test's own
 * `node:fs` stands in, and that test's listings go unseen;
 * mesh-never-lost failed 3 of 14 so, through the sandbox.
 *
 * The setup files themselves are not imported, since they register
 * hooks; what each imports is, read from the file, so a new route from
 * a setup file to the transport is caught without this list changing.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/mesh/transport.ts", () => {
	throw new Error("the mesh transport was loaded");
});

const TOP = resolve(import.meta.dirname, "../../../..");

/** Every setup file the vitest config names, by its path from the top. */
function setupFiles(): string[] {
	const config = readFileSync(join(TOP, "vitest.config.ts"), "utf8");
	const named = new Set<string>();
	for (const list of config.matchAll(/setupFiles:\s*\[([^\]]*)\]/g)) {
		for (const file of (list[1] ?? "").matchAll(/"([^"]+)"/g)) {
			if (file[1] !== undefined) named.add(file[1]);
		}
	}
	return [...named];
}

/** The modules of this package a setup file imports, as absolute paths. */
function importedBy(setup: string): string[] {
	const path = join(TOP, setup);
	const text = readFileSync(path, "utf8");
	return [...text.matchAll(/from\s+"(\.[^"]+)"/g)].flatMap((found) =>
		found[1] === undefined ? [] : [resolve(dirname(path), found[1])],
	);
}

/** Loads a module afresh, past what the setup files already loaded. */
function loadFresh(path: string): Promise<unknown> {
	return import(pathToFileURL(path).href);
}

describe("the setup files' imports", () => {
	it("are read from the config, so the guard has something to load", () => {
		const files = setupFiles();
		expect(files.length).toBeGreaterThan(0);
		expect(files.flatMap(importedBy).length).toBeGreaterThan(0);
	});

	it("load without the mesh transport, nor do the sandbox and fence", async () => {
		// The setup files loaded these already, before this mock.
		vi.resetModules();
		const modules = [
			...setupFiles().flatMap(importedBy),
			join(TOP, "lib/internal/sandbox/sandbox.ts"),
			join(TOP, "lib/internal/fence/fence.ts"),
			join(TOP, "lib/internal/fence/fence-run.ts"),
		];
		for (const module of modules) {
			await expect(loadFresh(module), module).resolves.toBeDefined();
		}
	});

	it("would be caught, since a module that loads the transport fails", async () => {
		vi.resetModules();
		await expect(
			loadFresh(join(TOP, "lib/mesh/worker-link.ts")),
			// Vitest wraps the factory's throw in its own mocking error.
		).rejects.toThrow(/error when mocking/);
	});
});
