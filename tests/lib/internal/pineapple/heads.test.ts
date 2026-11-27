import { describe, expect, it } from "vitest";
import {
	callSignal,
	type Exec,
	withCallSignal,
} from "../../../../lib/core/exec/index.ts";
import {
	askedHead,
	FAILED_FOR_MS,
	keptHeads,
	type Look,
	lookThrough,
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
	it("keeps a branch found for good, asking once", async () => {
		const time = clock();
		const { ask, asked } = answering(["drill"]);
		const headOf = keptHeads(ask, time.now);
		expect(await headOf("o/r", 1)).toBe("drill");
		time.pass(FAILED_FOR_MS * 10);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1"]);
	});

	it("counts a failed lookup's seconds from when it settled", async () => {
		const time = clock();
		const lookup = waiting();
		const headOf = keptHeads(lookup.ask, time.now);
		const first = headOf("o/r", 1);
		time.pass(10_000);
		lookup.settle();
		expect(await first).toBeUndefined();
		time.pass(FAILED_FOR_MS - 1);
		void headOf("o/r", 1);
		expect(lookup.asked).toEqual(["o/r#1"]);
	});

	it("asks again after a clock stepped back rather than holding", async () => {
		const time = clock();
		const { ask, asked } = answering([undefined, "drill"]);
		const headOf = keptHeads(ask, time.now);
		expect(await headOf("o/r", 1)).toBeUndefined();
		time.pass(-60 * 60 * 1000);
		expect(await headOf("o/r", 1)).toBe("drill");
		expect(asked).toEqual(["o/r#1", "o/r#1"]);
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
		time.pass(FAILED_FOR_MS - 1);
		expect(await headOf("o/r", 1)).toBeUndefined();
		expect(calls).toBe(1);
		time.pass(1);
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

/** A look answering gh and dt as given, a function to throw. */
function looking(gh: unknown, dt: unknown): Look {
	return async (program) => {
		const answer = program === "gh" ? gh : dt;
		if (typeof answer === "function") return answer();
		return answer === undefined ? undefined : String(answer);
	};
}

describe("askedHead", () => {
	const view = (ref: string) => JSON.stringify({ head: { ref } });

	it("takes GitHub's answer over Delta's", async () => {
		expect(await askedHead(looking("drill", view("other")))("o/r", 1)).toBe(
			"drill",
		);
	});

	it("takes Delta's where GitHub tells nothing or throws", async () => {
		expect(await askedHead(looking(undefined, view("drill")))("o/r", 1)).toBe(
			"drill",
		);
		const thrown = () => {
			throw new Error("door down");
		};
		expect(await askedHead(looking(thrown, view("drill")))("o/r", 1)).toBe(
			"drill",
		);
		const named = JSON.stringify({ headRefName: "drill" });
		expect(await askedHead(looking(undefined, named))("o/r", 1)).toBe("drill");
	});

	it("reads a whole ref as its short name, and a blank as none", async () => {
		const whole = view("refs/heads/drill");
		expect(await askedHead(looking(undefined, whole))("o/r", 1)).toBe("drill");
		expect(
			await askedHead(looking(undefined, view("")))("o/r", 1),
		).toBeUndefined();
		expect(await askedHead(looking("  ", view(" ")))("o/r", 1)).toBeUndefined();
	});

	it("stops Delta's lookup once GitHub names the branch", async () => {
		let delta: AbortSignal | undefined;
		const look: Look = async (program, _args, signal) => {
			if (program === "gh") return "drill";
			delta = signal;
			return await new Promise<undefined>(() => {
				// Delta never answers, as a hung one doesn't.
			});
		};
		expect(await askedHead(look)("o/r", 1)).toBe("drill");
		expect(delta).toHaveProperty("aborted", true);
	});

	it("leaves Delta's lookup running where GitHub tells nothing", async () => {
		const look: Look = async (program, _args, signal) => {
			if (program === "gh") return undefined;
			// GitHub has answered by now, telling nothing.
			await Promise.resolve();
			return signal?.aborted ? undefined : view("drill");
		};
		expect(await askedHead(look)("o/r", 1)).toBe("drill");
	});

	it("tells nothing where neither says, Delta throwing included", async () => {
		const thrown = () => {
			throw new Error("door down");
		};
		expect(await askedHead(looking(undefined, thrown))("o/r", 1)).toBe(
			undefined,
		);
		expect(
			await askedHead(looking(undefined, "not json"))("o/r", 1),
		).toBeUndefined();
		expect(await askedHead(looking("drill", view("x")))(undefined, 1)).toBe(
			undefined,
		);
	});
});

describe("lookThrough", () => {
	/** An exec printing `stdout` with `code`, keeping each signal it ran under. */
	function printing(code: number, stdout: string) {
		const signals: (AbortSignal | undefined)[] = [];
		const exec: Exec = async () => {
			signals.push(callSignal());
			return { code, stdout, stderr: "" };
		};
		return { exec, signals };
	}

	it("reads what a program printed, trimmed, and nothing where it failed", async () => {
		expect(await lookThrough(printing(0, " drill\n").exec)("gh", [])).toBe(
			"drill",
		);
		expect(await lookThrough(printing(0, " \n").exec)("gh", [])).toBe(
			undefined,
		);
		expect(await lookThrough(printing(1, "drill").exec)("gh", [])).toBe(
			undefined,
		);
	});

	it("runs a program under its own signal, never its call's", async () => {
		const { exec, signals } = printing(0, "drill");
		const own = new AbortController().signal;
		const call = new AbortController().signal;
		await withCallSignal(call, async () => {
			await lookThrough(exec)("dt", [], own);
			await lookThrough(exec)("gh", []);
		});
		expect(signals).toEqual([own, undefined]);
	});
});
