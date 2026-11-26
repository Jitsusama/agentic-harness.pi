/**
 * Where a carried tree may be put, over real folders and links: the
 * broker's trees and the person's unhidden folders under home, nowhere
 * else, however a link leads.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeRefused } from "../../../../lib/internal/carry/tree-place.ts";

let root: string;
let home: string;
let trees: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tree-place-"));
	home = join(root, "home");
	trees = join(home, ".local", "state", "pi", "work", "trees");
	mkdirSync(trees, { recursive: true });
	mkdirSync(join(home, "src"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("where a carried tree may be put", () => {
	it("takes the broker's trees, though a dot hides the folder they're in", () => {
		expect(placeRefused(join(trees, "cut"), home, trees)).toBeUndefined();
	});

	it("takes a folder of the person's own under home, made or not", () => {
		expect(
			placeRefused(join(home, "src", "app"), home, trees),
			"not there yet",
		).toBeUndefined();
		mkdirSync(join(home, "src", "here"));
		expect(
			placeRefused(join(home, "src", "here"), home, trees),
			"already there",
		).toBeUndefined();
		expect(
			placeRefused(join(home, "work", "deep", "app"), home, trees),
			"below folders not yet made",
		).toBeUndefined();
	});

	it("refuses a hidden folder outside the trees, as pi's extensions are", () => {
		expect(
			placeRefused(join(home, ".pi", "agent", "extensions", "x"), home, trees),
		).toMatch(/in a hidden folder outside the work broker's trees/);
		expect(
			placeRefused(join(home, "src", ".hooks"), home, trees),
			"hidden lower down",
		).toMatch(/hidden folder/);
	});

	it("refuses home itself and anywhere outside it", () => {
		expect(placeRefused(home, home, trees), "home").toMatch(
			/outside the person's home/,
		);
		expect(placeRefused(join(root, "elsewhere"), home, trees)).toMatch(
			/outside the person's home/,
		);
	});

	it("refuses a place a link leads out of them, as it really leads", () => {
		mkdirSync(join(home, ".config"));
		symlinkSync(join(home, ".config"), join(home, "src", "settings"));
		symlinkSync(join(root), join(home, "src", "out"));

		expect(
			placeRefused(join(home, "src", "settings", "app"), home, trees),
			"into a hidden folder",
		).toMatch(/hidden folder/);
		expect(
			placeRefused(join(home, "src", "out", "app"), home, trees),
			"out of home",
		).toMatch(/outside the person's home/);
	});
});
