/**
 * Which extension links moved after the process started: links made
 * since onto other code, and nothing else in the folder.
 */

import {
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linksMovedSince } from "../../../../lib/internal/reload/extension-links.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "extension-links-"));
	dirs.push(dir);
	return dir;
}

/** A tree holding an entry file and a helper beside it, as an extension's. */
function tree(root: string, name: string, helper: string): string {
	const at = join(root, name);
	mkdirSync(join(at, "lib"), { recursive: true });
	writeFileSync(join(at, "index.ts"), 'export * from "./lib/helper.ts";\n');
	writeFileSync(join(at, "lib", "helper.ts"), helper);
	return at;
}

/**
 * An extensions folder whose link the process found on `first` when it
 * started, an hour after the link was made, then made again onto
 * `second`, as the Mac's switch makes it.
 */
function remade(
	firstHelper: string,
	secondHelper: string,
): { dir: string; first: string; startedAt: number } {
	const root = folder();
	const first = tree(root, "first", firstHelper);
	const second = tree(root, "second", secondHelper);
	const dir = join(root, "extensions");
	mkdirSync(dir);
	const link = join(dir, "the-proxy");
	symlinkSync(first, link);
	const startedAt = Date.now() - 60_000;
	const hourBefore = (startedAt - 3_600_000) / 1000;
	lutimesSync(link, hourBefore, hourBefore);
	expect(linksMovedSince(dir, startedAt), "nothing moved yet").toEqual([]);
	rmSync(link);
	symlinkSync(second, link);
	return { dir, first, startedAt };
}

describe("extension links moved since a process started", () => {
	it("names a link made since, and not one made before or a real folder", () => {
		const dir = folder();
		const startedAt = Date.now();
		symlinkSync("/nix/store/a-target", join(dir, "made-before"));
		// An hour before the process, as a link left from an earlier launch.
		const hourBefore = (startedAt - 3_600_000) / 1000;
		lutimesSync(join(dir, "made-before"), hourBefore, hourBefore);
		symlinkSync("/nix/store/gone-target", join(dir, "made-since"));
		mkdirSync(join(dir, "a-folder"));

		expect(
			linksMovedSince(dir, startedAt - 60_000),
			"only the link made after the start",
		).toEqual(["made-since"]);
	});

	it("names no link made again onto a tree the same as its first", () => {
		const { dir, startedAt } = remade(
			"export const a = 1;\n",
			"export const a = 1;\n",
		);

		expect(
			linksMovedSince(dir, startedAt),
			"the same entry and helpers read from either tree",
		).toEqual([]);
	});

	it("names a link made again onto a tree that differs by a byte", () => {
		const { dir, startedAt } = remade(
			"export const a = 1;\n",
			"export const a = 2;\n",
		);

		expect(
			linksMovedSince(dir, startedAt),
			"a reload would mix the new entry with the first helper",
		).toEqual(["the-proxy"]);
	});

	it("names a link whose first target is gone, though the trees were the same", () => {
		const { dir, first, startedAt } = remade(
			"export const a = 1;\n",
			"export const a = 1;\n",
		);
		expect(
			linksMovedSince(dir, startedAt),
			"the same while both stand",
		).toEqual([]);

		rmSync(first, { recursive: true });

		expect(
			linksMovedSince(dir, startedAt),
			"a reload's imports resolve against the collected first target",
		).toEqual(["the-proxy"]);
	});

	it("names a link the process first found already made since it started", () => {
		const root = folder();
		const first = tree(root, "first", "export const a = 1;\n");
		const second = tree(root, "second", "export const a = 1;\n");
		const dir = join(root, "extensions");
		mkdirSync(dir);
		const startedAt = Date.now() - 60_000;
		symlinkSync(first, join(dir, "the-proxy"));
		expect(
			linksMovedSince(dir, startedAt),
			"where it first pointed is unknown, so it counts as moved",
		).toEqual(["the-proxy"]);

		rmSync(join(dir, "the-proxy"));
		symlinkSync(second, join(dir, "the-proxy"));

		expect(linksMovedSince(dir, startedAt), "and still does").toEqual([
			"the-proxy",
		]);
	});

	it("names a link made again onto nothing", () => {
		const { dir, startedAt } = remade(
			"export const a = 1;\n",
			"export const a = 1;\n",
		);
		rmSync(join(dir, "the-proxy"));
		symlinkSync(join(dir, "nowhere"), join(dir, "the-proxy"));

		expect(linksMovedSince(dir, startedAt), "nothing to load the same").toEqual(
			["the-proxy"],
		);
	});

	it("names nothing when the folder can't be read", () => {
		expect(
			linksMovedSince(join(folder(), "missing"), 0),
			"a missing folder has loaded nothing",
		).toEqual([]);
	});
});
