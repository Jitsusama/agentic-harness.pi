import { describe, expect, it } from "vitest";
import { keptHeads } from "../../../../lib/internal/pineapple/heads.ts";

/** A lookup giving each answer in turn, counting how often it's asked. */
function answering(answers: (string | undefined)[]) {
	const asked: string[] = [];
	const ask = async (repo: string | undefined, pr: number) => {
		asked.push(`${repo}#${pr}`);
		return answers.shift();
	};
	return { ask, asked };
}

describe("keptHeads", () => {
	it("keeps a branch found, asking once", async () => {
		const { ask, asked } = answering(["drill"]);
		const headOf = keptHeads(ask);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1"]);
	});

	it("asks again after a lookup that found nothing", async () => {
		const { ask, asked } = answering([undefined, "drill"]);
		const headOf = keptHeads(ask);
		expect(await headOf("o/r", 1)).toBeUndefined();
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1", "o/r#1"]);
	});

	it("asks again after a lookup that threw", async () => {
		let calls = 0;
		const headOf = keptHeads(async () => {
			calls += 1;
			if (calls === 1) throw new Error("door down");
			return "drill";
		});
		await expect(headOf("o/r", 1)).rejects.toThrow("door down");
		expect(await headOf("o/r", 1)).toBe("drill");
	});

	it("asks nothing where the repository is unknown", async () => {
		const { ask, asked } = answering(["drill"]);
		expect(await keptHeads(ask)(undefined, 1)).toBeUndefined();
		expect(asked).toEqual([]);
	});
});
