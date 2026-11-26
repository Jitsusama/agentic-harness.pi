/**
 * Where a path leads past its links, made yet or not, as the system
 * would land a write to it.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	type PathLike,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadsTo, linksOn } from "../../../../lib/internal/sandbox/leads-to.ts";

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

	it("follows as many links as the system would, and gives up past them", () => {
		// C0 is no link, so a chain from Cn follows n links.
		mkdirSync(join(home, "C0"));
		for (let link = 1; link <= 41; link++)
			symlinkSync(`C${link - 1}`, join(home, `C${link}`));

		expect(leadsTo(join(home, "C40", "made"))).toBe(join(home, "C0", "made"));
		expect(leadsTo(join(home, "C41", "made"))).toBeUndefined();
	});

	it("follows the system's count of links whose targets each hold hundreds of names", () => {
		// Each target is a thousand bytes, inside a Mac's limit and Linux's.
		const padding = "./".repeat(495);
		mkdirSync(join(home, "P0"));
		for (let link = 1; link <= 40; link++)
			symlinkSync(`${padding}P${link - 1}`, join(home, `P${link}`));

		expect(leadsTo(join(home, "P40", "made"))).toBe(join(home, "P0", "made"));
	});

	// Root looks in any folder, so only another account meets the refusal.
	it.skipIf(process.getuid?.() === 0)(
		"says nothing of a name it can't look at, rather than take it as not made",
		() => {
			// A link here may lead anywhere, so judging the path as spelled
			// would let a write land where no check looked.
			const locked = join(home, "locked");
			mkdirSync(locked);
			chmodSync(locked, 0o000);
			try {
				expect(leadsTo(join(locked, "inside"))).toBeUndefined();
			} finally {
				chmodSync(locked, 0o700);
			}
		},
	);

	it("says nothing of a link whose target isn't UTF-8, rather than follow another name", () => {
		symlinkSync(
			Buffer.from([0x66, 0xff, 0x2f, 0x78]),
			join(home, "really", "odd"),
		);
		expect(leadsTo(join(home, "two", "linked", "odd"))).toBeUndefined();
	});

	it("leads a name below a file to where the file's folder leads, as nothing there", () => {
		writeFileSync(join(home, "really", "plain"), "");
		expect(leadsTo(join(home, "two", "linked", "plain", "below"))).toBe(
			join(home, "really", "plain", "below"),
		);
	});

	it("names a link whose target isn't UTF-8 among those it met", () => {
		// A command that may change it may send the path anywhere.
		const odd = join(home, "really", "odd");
		symlinkSync(Buffer.from([0x66, 0xff]), odd);
		expect(linksOn(join(home, "two", "linked", "odd", "x"))).toEqual([
			join(home, "two", "linked"),
			odd,
		]);
	});

	it("keeps a relative path's leading `..`, as the system reads it", () => {
		// Names no checkout's surroundings hold, since these are read from
		// wherever the run's folder lies.
		const x = `leads-to-never-made-${process.pid}`;
		expect(leadsTo(join("..", x))).toBe(join("..", x));
		expect(leadsTo(`../../${x}`)).toBe(join("..", "..", x));
		expect(leadsTo(`${x}/../../${x}`)).toBe(join("..", x));
	});
});
