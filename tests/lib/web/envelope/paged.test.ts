import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIMIT,
	type PageShape,
	paginate,
} from "../../../../lib/web/envelope/paged.js";

interface Entry {
	id: number;
	level: string;
	text: string;
}

function entries(count: number, level = "error"): Entry[] {
	return Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		level,
		text: `entry ${i + 1}`,
	}));
}

const shape: PageShape<Entry> = { idOf: (entry) => entry.id };

describe("paginate", () => {
	it("reports the whole list's size, not the window's", () => {
		const page = paginate(entries(100), {}, shape);

		expect(page.total).toBe(100);
		expect(page.items).toHaveLength(DEFAULT_LIMIT);
	});

	it("counts by group across everything, not just the window", () => {
		const all = [...entries(30, "error"), ...entries(5, "warning")];

		const page = paginate(all, {}, { ...shape, groupOf: (e) => e.level });

		expect(page.groups).toEqual({ error: 30, warning: 5 });
	});

	it("lets the caller raise the window past the default", () => {
		const page = paginate(entries(100), { limit: 50 }, shape);

		expect(page.items).toHaveLength(50);
	});

	it("offers a cursor while items remain", () => {
		const page = paginate(entries(100), { limit: 10 }, shape);

		expect(page.nextCursor).toBeDefined();
	});

	it("offers no cursor once the list is exhausted", () => {
		const page = paginate(entries(5), { limit: 10 }, shape);

		expect(page.nextCursor).toBeUndefined();
	});

	it("resumes exactly where it stopped, with no gap and no repeat", () => {
		const all = entries(25);

		const first = paginate(all, { limit: 10 }, shape);
		const second = paginate(
			all,
			{ limit: 10, cursor: first.nextCursor },
			shape,
		);
		const third = paginate(
			all,
			{ limit: 10, cursor: second.nextCursor },
			shape,
		);

		const seen = [...first.items, ...second.items, ...third.items];
		expect(seen.map((e) => e.id)).toEqual(all.map((e) => e.id));
		expect(third.nextCursor).toBeUndefined();
	});

	it("fetches exactly the ids asked for, ignoring the window", () => {
		const page = paginate(entries(100), { ids: [7, 42] }, shape);

		expect(page.items.map((e) => e.id)).toEqual([7, 42]);
	});

	it("says what the byte budget cut, and how to get it", () => {
		const page = paginate(
			entries(100),
			{ limit: 100, budget: 200 },
			{ ...shape, more: "narrow with level" },
		);

		expect(page.items.length).toBeLessThan(100);
		expect(page.elided).toContain("narrow with level");
		expect(page.elided).toMatch(/\d+/);
	});

	it("treats the budget as a default the caller can raise", () => {
		const tight = paginate(entries(100), { limit: 100, budget: 200 }, shape);
		const loose = paginate(
			entries(100),
			{ limit: 100, budget: 200_000 },
			shape,
		);

		expect(loose.items.length).toBeGreaterThan(tight.items.length);
		expect(loose.elided).toBeUndefined();
	});

	it("keeps at least one item so a huge record is never invisible", () => {
		const page = paginate(entries(10), { budget: 1 }, shape);

		expect(page.items).toHaveLength(1);
		expect(page.elided).toBeDefined();
	});

	it("passes through what a ring buffer already evicted", () => {
		const page = paginate(entries(10), {}, { ...shape, dropped: 4 });

		expect(page.dropped).toBe(4);
	});

	it("returns an empty window honestly", () => {
		const page = paginate([], {}, shape);

		expect(page.total).toBe(0);
		expect(page.items).toEqual([]);
		expect(page.nextCursor).toBeUndefined();
	});
});
