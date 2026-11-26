/**
 * Where a path leads past its links, made yet or not, as the system
 * would land a write to it.
 */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadsTo } from "../../../../lib/internal/sandbox/leads-to.ts";

let home: string;

beforeEach(() => {
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
});
