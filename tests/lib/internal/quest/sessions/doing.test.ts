import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	doingNow,
	readDoing,
	sayDoing,
} from "../../../../../lib/internal/quest/sessions/doing.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "doing-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A quest folder with a README and a Journey file, newest first. */
function questWith(entries: readonly string[]): string {
	writeFileSync(join(dir, "README.md"), "---\nid: QEST-1\n---\n# Q\n");
	writeFileSync(
		join(dir, "JOURNEY.md"),
		`# Journey\n\n${entries.join("\n")}\n`,
	);
	return dir;
}

const plan = (currentItem: string | undefined) => ({
	questDir: questWith([
		"- **2026-11-15**: Chose the file beside the record.\n  Because the registry is long.",
		"- **2026-11-14**: An older choice.",
	]),
	documentId: "PLAN-1",
	documentKind: "plan" as const,
	...(currentItem === undefined ? {} : { currentItem }),
});

describe("what a session is doing", () => {
	it("says the focused plan's next item, by number, and the newest choice", () => {
		expect(
			doingNow(plan("251. Put `doing` on **the** [presence](x.md)")),
			"the item's number apart, markdown stripped, the Journey's first line",
		).toEqual({
			plan: "PLAN-1",
			item: 251,
			next: "Put doing on the presence",
			chose: "Chose the file beside the record.",
		});
	});

	it("says an item with no number as it reads, cut to 120 characters", () => {
		const long = "word ".repeat(40).trim();
		const doing = doingNow(plan(long));
		expect(doing?.item, "no number to give").toBeUndefined();
		expect(doing?.next.length, "cut to the limit").toBe(120);
		expect(doing?.next.endsWith("..."), "said to be cut").toBe(true);
	});

	it("says nothing without a focused plan, or with every item done", () => {
		expect(
			doingNow({ ...plan("1. x"), documentKind: "research" }),
			"research isn't a plan",
		).toBeUndefined();
		expect(
			doingNow({ ...plan("1. x"), documentId: null }),
			"nothing focused",
		).toBeUndefined();
		expect(doingNow(plan(undefined)), "nothing open").toBeUndefined();
	});

	it("leaves the choice out while the Journey is empty", () => {
		writeFileSync(join(dir, "README.md"), "# Q\n");
		expect(
			doingNow({
				questDir: dir,
				documentId: "PLAN-1",
				documentKind: "plan",
				currentItem: "2. y",
			}),
			"no entry to name",
		).toEqual({ plan: "PLAN-1", item: 2, next: "y" });
	});
});

describe("saying it for the presence", () => {
	it("writes it with its time, keeps the time while it stands, and moves it on a change", () => {
		const folder = join(dir, "doing");
		const first = { plan: "PLAN-1", item: 1, next: "a" };
		sayDoing(folder, "s1", first, new Date("2026-11-15T13:00:00Z"));
		expect(readDoing(folder, "s1"), "written with its time").toEqual({
			...first,
			at: "2026-11-15T13:00:00.000Z",
		});
		sayDoing(folder, "s1", first, new Date("2026-11-15T13:05:00Z"));
		expect(readDoing(folder, "s1")?.at, "unchanged, so the time stands").toBe(
			"2026-11-15T13:00:00.000Z",
		);
		sayDoing(
			folder,
			"s1",
			{ ...first, item: 2, next: "b" },
			new Date("2026-11-15T13:06:00Z"),
		);
		expect(readDoing(folder, "s1"), "changed, so the time moves").toEqual({
			plan: "PLAN-1",
			item: 2,
			next: "b",
			at: "2026-11-15T13:06:00.000Z",
		});
	});

	it("takes it away when there's nothing to say", () => {
		const folder = join(dir, "doing");
		sayDoing(folder, "s1", { plan: "PLAN-1", next: "a" }, new Date());
		sayDoing(folder, "s1", undefined, new Date());
		expect(existsSync(join(folder, "s1.json")), "removed").toBe(false);
		expect(readDoing(folder, "s1"), "nothing read").toBeUndefined();
		sayDoing(folder, "s2", undefined, new Date());
		expect(readDoing(folder, "s2"), "nothing to remove").toBeUndefined();
	});

	it("reads nothing from a file that isn't one", () => {
		const folder = join(dir, "doing");
		sayDoing(folder, "s1", { plan: "PLAN-1", next: "a" }, new Date());
		writeFileSync(join(folder, "s1.json"), '{"plan": 3}');
		expect(readDoing(folder, "s1"), "malformed").toBeUndefined();
		expect(readFileSync(join(folder, "s1.json"), "utf8"), "left alone").toBe(
			'{"plan": 3}',
		);
	});
});
