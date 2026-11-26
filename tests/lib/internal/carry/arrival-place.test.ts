/**
 * Where an arriving carry may put a tree, over real folders and links:
 * directly within the broker's trees, or under home's src and world
 * where no dot hides a part and no checkout lies above, and nowhere
 * else, however a link leads.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeRefused } from "../../../../lib/internal/carry/arrival-place.ts";

let root: string;
let home: string;
let trees: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "arrival-place-"));
	home = join(root, "home");
	trees = join(home, ".local", "state", "pi", "work", "trees");
	mkdirSync(trees, { recursive: true });
	mkdirSync(join(home, "src"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("where an arriving carry may put a tree", () => {
	it("takes a tree directly within the broker's trees, though a dot hides the folder they're in", () => {
		expect(placeRefused(join(trees, "cut"), home, trees)).toBeUndefined();
	});

	it("refuses a hidden name in the trees, or a place inside another tree there", () => {
		mkdirSync(join(trees, "live"));
		expect(
			placeRefused(join(trees, ".cut"), home, trees),
			"a hidden name",
		).toMatch(/under a hidden name in the work broker's trees/);
		expect(
			placeRefused(join(trees, "live", ".pi", "extensions", "x"), home, trees),
			"in another tree's settings",
		).toMatch(/inside another of the work broker's trees/);
		expect(
			placeRefused(join(trees, "live", "lib"), home, trees),
			"in another tree at all",
		).toMatch(/inside another of the work broker's trees/);
	});

	it("takes the broker's trees reached through a link, made or not", () => {
		const state = join(root, "state");
		mkdirSync(state);
		const linked = join(home, "linked-state");
		symlinkSync(state, linked);
		const unmade = join(linked, "work", "trees");

		expect(
			placeRefused(join(unmade, "cut"), home, unmade),
			"trees not made yet, under a link",
		).toBeUndefined();
		mkdirSync(unmade, { recursive: true });
		expect(
			placeRefused(join(state, "work", "trees", "cut"), home, unmade),
			"the place written past the link",
		).toBeUndefined();
	});

	it("refuses a place in the trees that a link leads out of them", () => {
		symlinkSync(join(home, ".pi-agent"), join(trees, "out"));
		mkdirSync(join(home, ".pi-agent"));

		expect(placeRefused(join(trees, "out", "x"), home, trees)).toMatch(
			/outside the work broker's trees/,
		);
	});

	it("takes a folder under src or world, made or not, below folders not yet made", () => {
		expect(
			placeRefused(join(home, "src", "app"), home, trees),
			"src",
		).toBeUndefined();
		expect(
			placeRefused(join(home, "world", "trees", "root", "src"), home, trees),
			"world, below folders not yet made",
		).toBeUndefined();
		mkdirSync(join(home, "src", "here"));
		expect(
			placeRefused(join(home, "src", "here"), home, trees),
			"already there",
		).toBeUndefined();
	});

	it("refuses an unhidden folder that may load code, home itself, and outside home", () => {
		for (const place of [
			join(home, "bin", "app"),
			join(home, "node_modules", "app"),
			join(home, "Library", "LaunchAgents", "app"),
			join(home, "app"),
			join(home, "src"),
			home,
			join(root, "elsewhere", "app"),
		]) {
			expect(placeRefused(place, home, trees), place).toMatch(
				/outside the work broker's trees at .* and the folders checkouts go in, ~\/src and ~\/world/,
			);
		}
	});

	it("refuses a hidden folder under src", () => {
		expect(placeRefused(join(home, "src", ".hooks", "x"), home, trees)).toMatch(
			/in a hidden folder/,
		);
	});

	it("refuses a place inside a checkout already there", () => {
		mkdirSync(join(home, "src", "harness", "extensions"), { recursive: true });
		writeFileSync(join(home, "src", "harness", ".git"), "gitdir: elsewhere\n");

		expect(
			placeRefused(
				join(home, "src", "harness", "extensions", "x"),
				home,
				trees,
			),
		).toMatch(
			new RegExp(`inside the checkout at ${join(home, "src", "harness")}`),
		);
		expect(
			placeRefused(join(home, "src", "harness"), home, trees),
			"the checkout itself is its own place",
		).toBeUndefined();
	});

	it("refuses where a link leads out, judged past every part not yet made", () => {
		mkdirSync(join(home, ".config"));
		symlinkSync(join(home, ".config"), join(home, "src", "settings"));
		symlinkSync(root, join(home, "src", "out"));
		symlinkSync(join(home, "bin"), join(home, "src", "tools"));

		expect(
			placeRefused(join(home, "src", "settings", "a", "b"), home, trees),
			"into a hidden folder, two parts below",
		).toMatch(/outside the work broker's trees/);
		expect(
			placeRefused(join(home, "src", "out", "a", "b"), home, trees),
			"out of home, two parts below",
		).toMatch(/outside the work broker's trees/);
		expect(
			placeRefused(join(home, "src", "tools", "app"), home, trees),
			"a link that leads nowhere",
		).toMatch(/through a link that leads nowhere/);
	});

	it("judges the place itself where it is a link", () => {
		symlinkSync(join(home, ".config"), join(home, "src", "app"));
		mkdirSync(join(home, ".config"));

		expect(placeRefused(join(home, "src", "app"), home, trees)).toMatch(
			/outside the work broker's trees/,
		);
	});
});
