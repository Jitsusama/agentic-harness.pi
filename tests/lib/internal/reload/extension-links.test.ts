/**
 * Which extension links moved after the process started: links made
 * since, and nothing else in the folder.
 */

import {
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
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

	it("names nothing when the folder can't be read", () => {
		expect(
			linksMovedSince(join(folder(), "missing"), 0),
			"a missing folder has loaded nothing",
		).toEqual([]);
	});
});
