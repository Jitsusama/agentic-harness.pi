/**
 * Where a path leads past its links, made yet or not, as the system
 * would land a write to it.
 */
import {
	mkdirSync,
	mkdtempSync,
	type PathLike,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadsTo } from "../../../../lib/internal/sandbox/leads-to.ts";

// The walk's look at each name, counted, and refused past a ceiling, so a
// walk that runs away fails at once rather than hold the worker for ever.
// A setup file loads the walk before this file's mock is made, so a case
// counting its looks imports a fresh copy.
const looks = vi.hoisted(() => ({ count: 0, most: Number.POSITIVE_INFINITY }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		lstatSync: (path: PathLike) => {
			looks.count += 1;
			if (looks.count > looks.most) throw new Error("looked too often");
			return fs.lstatSync(path);
		},
	};
});

let home: string;

beforeEach(() => {
	looks.count = 0;
	looks.most = Number.POSITIVE_INFINITY;
	home = realpathSync(mkdtempSync(join(tmpdir(), "leads-to-")));
	mkdirSync(join(home, "really"));
	mkdirSync(join(home, "two"));
	symlinkSync(join(home, "really"), join(home, "two", "linked"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("leadsTo", () => {
	it("leads a path that is there to where it really is", () => {
		expect(leadsTo(join(home, "two", "linked"))).toBe(join(home, "really"));
	});

	it("leads a name not made yet to where its folder leads", () => {
		expect(leadsTo(join(home, "two", "linked", "new", "deeper"))).toBe(
			join(home, "really", "new", "deeper"),
		);
	});

	it("leads a link to nothing to the file a write through it would make", () => {
		symlinkSync(join(home, "elsewhere", "file"), join(home, "really", "abs"));
		expect(leadsTo(join(home, "two", "linked", "abs"))).toBe(
			join(home, "elsewhere", "file"),
		);
	});

	it("reads a relative link from where its folder leads, not how it is spelled", () => {
		// The system reads ../ from really, the folder the link lies in, so
		// the file is made beside it, not beside the link to that folder.
		symlinkSync(join("..", "elsewhere", "file"), join(home, "really", "rel"));
		expect(leadsTo(join(home, "two", "linked", "rel"))).toBe(
			join(home, "elsewhere", "file"),
		);
	});

	it("climbs from where a link leads, not from how its path is spelled", () => {
		// Built as a string, since join would fold the `..` as text.
		const climbed = `${join(home, "two", "linked")}/../beside`;
		expect(leadsTo(climbed)).toBe(join(home, "beside"));
	});

	it("climbs a link's own `..` from where the links in it lead", () => {
		const target = ["..", "two", "linked", "..", "made"].join("/");
		symlinkSync(target, join(home, "really", "back"));
		expect(leadsTo(join(home, "really", "back"))).toBe(join(home, "made"));
	});

	it("follows a link to nothing through a chain of them", () => {
		symlinkSync(join(home, "really", "next"), join(home, "first"));
		symlinkSync(join("..", "last"), join(home, "really", "next"));
		expect(leadsTo(join(home, "first"))).toBe(join(home, "last"));
	});

	it("leads nowhere where its links loop", () => {
		symlinkSync(join(home, "b"), join(home, "a"));
		symlinkSync(join(home, "a"), join(home, "b"));
		expect(leadsTo(join(home, "a"))).toBeUndefined();
		expect(leadsTo(join(home, "a", "below"))).toBeUndefined();
	});

	it("counts links across the whole walk, so links that fan out end at once", async () => {
		// Each level names the one below four times, so a count kept per
		// chain would follow 4^20 of them before it gave up.
		symlinkSync(".", join(home, "L0"));
		for (let level = 1; level <= 20; level++) {
			const below = `L${level - 1}`;
			symlinkSync(
				[below, below, below, below].join("/"),
				join(home, `L${level}`),
			);
		}
		vi.resetModules();
		const counted = await import(
			"../../../../lib/internal/sandbox/leads-to.ts"
		);
		looks.most = 5_000;

		expect(counted.leadsTo(join(home, "L20"))).toBeUndefined();
		expect(looks.count, "the walk's looks weren't counted").toBeGreaterThan(0);
		expect(looks.count).toBeLessThan(5_000);
	});

	it("follows links that fan out as far as the system would", () => {
		// Seven links in all, well inside the system's count.
		symlinkSync(".", join(home, "L0"));
		symlinkSync("L0/L0", join(home, "L1"));
		symlinkSync("L1/L1", join(home, "L2"));

		expect(leadsTo(join(home, "L2", "made"))).toBe(join(home, "made"));
	});

	it("keeps a relative path's leading `..`, as the system reads it", () => {
		expect(leadsTo(join("..", "x"))).toBe(join("..", "x"));
		expect(leadsTo("../../x")).toBe(join("..", "..", "x"));
		expect(leadsTo("not-made/../../x")).toBe(join("..", "x"));
	});
});
