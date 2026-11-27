import { describe, expect, it } from "vitest";
import {
	FAILED_FOR_MS,
	keptHeads,
} from "../../../../lib/internal/pineapple/heads.ts";

/** A lookup giving each answer in turn, counting how often it's asked. */
function answering(answers: (string | undefined)[]) {
	const asked: string[] = [];
	const ask = async (repo: string | undefined, pr: number) => {
		asked.push(`${repo}#${pr}`);
		return answers.shift();
	};
	return { ask, asked };
}

/**
 * A lookup that answers only once `settle` is called, settling every ask
 * made so far, so a lookup asked twice fails on `asked`, not a timeout.
 */
function waiting() {
	const asked: string[] = [];
	const settles: ((head: string | undefined) => void)[] = [];
	const ask = (repo: string | undefined, pr: number) => {
		asked.push(`${repo}#${pr}`);
		return new Promise<string | undefined>((resolve) => {
			settles.push(resolve);
		});
	};
	const settle = (head?: string) => {
		for (const one of settles.splice(0)) one(head);
	};
	return { ask, asked, settle };
}

/** A clock that stands still until moved on. */
function clock() {
	let at = 1_000_000;
	const pass = (ms: number) => {
		at += ms;
	};
	return { now: () => at, pass };
}

describe("keptHeads", () => {
	it("keeps a branch found, asking once", async () => {
		const { ask, asked } = answering(["drill"]);
		const headOf = keptHeads(ask);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1"]);
	});

	it("asks again once a lookup that found nothing is old enough", async () => {
		const time = clock();
		const { ask, asked } = answering([undefined, "drill"]);
		const headOf = keptHeads(ask, time.now);
		expect(await headOf("o/r", 1)).toBeUndefined();
		time.pass(FAILED_FOR_MS - 1);
		expect(await headOf("o/r", 1)).toBeUndefined();
		expect(asked).toEqual(["o/r#1"]);
		time.pass(1);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1", "o/r#1"]);
	});

	it("reads a lookup that threw as telling nothing, and asks again", async () => {
		const time = clock();
		let calls = 0;
		const headOf = keptHeads(async () => {
			calls += 1;
			if (calls === 1) throw new Error("door down");
			return "drill";
		}, time.now);
		expect(await headOf("o/r", 1)).toBeUndefined();
		time.pass(FAILED_FOR_MS);
		expect(await headOf("o/r", 1)).toBe("drill");
	});

	it("asks nothing where the repository is unknown", async () => {
		const { ask, asked } = answering(["drill"]);
		expect(await keptHeads(ask)(undefined, 1)).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("shares a lookup under way with every write asking meanwhile", async () => {
		const lookup = waiting();
		const headOf = keptHeads(lookup.ask);
		const first = headOf("o/r", 1);
		const second = headOf("o/r", 1);
		lookup.settle("drill");
		expect(await Promise.all([first, second])).toEqual(["drill", "drill"]);
		expect(lookup.asked).toEqual(["o/r#1"]);
	});

	it("keeps each pull request's branch apart", async () => {
		const { ask, asked } = answering(["drill", "other"]);
		const headOf = keptHeads(ask);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(await headOf("o/r", 2)).toBe("other");
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1", "o/r#2"]);
	});

	it("keeps each repository's branch apart", async () => {
		const { ask, asked } = answering(["drill", "other"]);
		const headOf = keptHeads(ask);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(await headOf("o/x", 1)).toBe("other");
		expect(asked).toEqual(["o/r#1", "o/x#1"]);
	});
});
