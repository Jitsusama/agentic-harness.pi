import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../../lib/core/exec/index.ts";
import {
	headAmong,
	keptHeads,
	listedHead,
} from "../../../../lib/internal/pineapple/heads.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";

/** A lookup giving each answer in turn, counting how often it's asked. */
function answering(answers: (string | undefined)[]) {
	const asked: string[] = [];
	const ask = async (repo: string | undefined, pr: number) => {
		asked.push(`${repo}#${pr}`);
		return answers.shift();
	};
	return { ask, asked };
}

/** A lookup that answers only once `settle` is called. */
function waiting() {
	const asked: string[] = [];
	let settle: (head: string | undefined) => void = () => {};
	const ask = (repo: string | undefined, pr: number) => {
		asked.push(`${repo}#${pr}`);
		return new Promise<string | undefined>((resolve) => {
			settle = resolve;
		});
	};
	return { ask, asked, settle: (head?: string) => settle(head) };
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
		const { ask: guess, asked: guessed } = answering(["copy"]);
		expect(await keptHeads(ask, guess)(undefined, 1)).toBeUndefined();
		expect(asked).toEqual([]);
		expect(guessed).toEqual([]);
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

	it("guesses only where the lookup tells nothing", async () => {
		const { ask } = answering(["drill"]);
		const { ask: guess, asked: guessed } = answering(["copy"]);
		expect(await keptHeads(ask, guess)("o/r", 1)).toBe("drill");
		expect(guessed).toEqual([]);
	});

	it("never keeps a guess, asking it again at each write", async () => {
		const { ask, asked } = answering([undefined, undefined]);
		const { ask: guess, asked: guessed } = answering(["copy", "drill"]);
		const headOf = keptHeads(ask, guess);
		expect(await headOf("o/r", 1)).toBe("copy");
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1", "o/r#1"]);
		expect(guessed).toEqual(["o/r#1", "o/r#1"]);
	});

	it("keeps a branch told after a guess, guessing no more", async () => {
		const { ask, asked } = answering([undefined, "drill"]);
		const { ask: guess, asked: guessed } = answering(["copy"]);
		const headOf = keptHeads(ask, guess);
		expect(await headOf("o/r", 1)).toBe("copy");
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1", "o/r#1"]);
		expect(guessed).toEqual(["o/r#1"]);
	});

	it("shares a guess under way with every write asking meanwhile", async () => {
		const guess = waiting();
		const headOf = keptHeads(async () => undefined, guess.ask);
		const first = headOf("o/r", 1);
		const second = headOf("o/r", 1);
		// Each write's lookup settles before it asks for the guess.
		await new Promise((resolve) => setImmediate(resolve));
		guess.settle("drill");
		expect(await Promise.all([first, second])).toEqual(["drill", "drill"]);
		expect(guess.asked).toEqual(["o/r#1"]);
	});
});

describe("listedHead", () => {
	let place: string;
	let origin: string;

	beforeEach(async () => {
		place = await freshRepo("listed-head");
		origin = join(place, "origin.git");
		await git(place, "clone", "-q", "--bare", place, origin);
		const tip = await git(place, "rev-parse", "HEAD");
		await git(origin, "update-ref", "refs/heads/feat/drill", tip);
		await git(origin, "update-ref", "refs/pull/7/head", tip);
		await git(place, "commit", "-q", "--allow-empty", "-m", "next");
		await git(place, "push", "-q", origin, "HEAD:main");
	});

	afterEach(() => disposeRepo(place));

	it("names the pull request's branch from git's listing", async () => {
		expect(await listedHead(spawnExec(), origin, 7)).toBe("feat/drill");
	});

	it("names none for a pull request the listing doesn't hold", async () => {
		expect(await listedHead(spawnExec(), origin, 8)).toBeUndefined();
	});

	it("names none where the listing fails", async () => {
		const missing = join(place, "missing.git");
		expect(await listedHead(spawnExec(), missing, 7)).toBeUndefined();
	});
});

describe("headAmong", () => {
	const listing = [
		"aaa\trefs/heads/main",
		"bbb\trefs/heads/drill",
		"ccc\trefs/heads/other",
		"bbb\trefs/pull/7/head",
		"ddd\trefs/pull/8/head",
	].join("\n");

	it("names the one branch standing at the pull request's head", () => {
		expect(headAmong(listing, 7)).toBe("drill");
	});

	it("names none where no branch stands there", () => {
		expect(headAmong(listing, 8)).toBeUndefined();
	});

	it("names none where the pull request isn't listed", () => {
		expect(headAmong(listing, 9)).toBeUndefined();
	});

	it("names none where two branches stand there", () => {
		expect(headAmong(`${listing}\nbbb\trefs/heads/copy`, 7)).toBeUndefined();
	});

	it("reads a branch with slashes from lines ending in a return", () => {
		const said = "bbb\trefs/heads/feat/x\r\nbbb\trefs/pull/3/head\r\n";
		expect(headAmong(said, 3)).toBe("feat/x");
	});
});
