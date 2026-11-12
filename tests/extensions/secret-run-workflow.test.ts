import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerText } from "../../extensions/secret-run-workflow/index.ts";
import { waitForAnswer } from "../../extensions/secret-run-workflow/wait.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secret-run-"));
	mkdirSync(join(dir, "asks"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ID = "3f0c9e2a7b5d41e8a6c2f9d01b7e4a35";

function answer(said: object): void {
	writeFileSync(
		join(dir, "asks", `${ID}.answer.json`),
		JSON.stringify({ version: 1, id: ID, ...said }),
	);
}

describe("waiting on an ask's answer", () => {
	it("ends on the answer once the daemon writes it", async () => {
		const waited = waitForAnswer(
			join(dir, "asks"),
			ID,
			new AbortController().signal,
			10_000,
		);
		answer({ state: "refused", why: "refused by Joel" });

		expect(await waited).toEqual({
			kind: "answered",
			answer: { state: "refused", why: "refused by Joel" },
		});
	});

	it("ends on an answer written before the wait began", async () => {
		answer({ state: "ran", exit: 0, output: "SECRET 12", cut: false, why: "" });

		expect(
			await waitForAnswer(
				join(dir, "asks"),
				ID,
				new AbortController().signal,
				10_000,
			),
		).toMatchObject({ kind: "answered", answer: { state: "ran", exit: 0 } });
	});

	it("ends when the call is stopped", async () => {
		const stop = new AbortController();
		const waited = waitForAnswer(join(dir, "asks"), ID, stop.signal, 10_000);
		stop.abort();

		expect(await waited).toEqual({ kind: "stopped" });
	});

	it("ends unanswered when nobody writes by its deadline", async () => {
		expect(
			await waitForAnswer(
				join(dir, "asks"),
				ID,
				new AbortController().signal,
				50,
			),
		).toEqual({ kind: "unanswered" });
	});
});

describe("what the agent hears of an answer", () => {
	it("says a yes's exit and masked output", () => {
		const text = answerText({
			state: "ran",
			exit: 0,
			output: "SECRET 12",
			cut: true,
			why: "",
		});

		expect(text).toContain("exited 0");
		expect(text).toContain("SECRET 12");
		expect(text).toContain("cut at its cap");
	});

	it("says a run stopped at its limit", () => {
		expect(
			answerText({
				state: "ran",
				exit: null,
				why: "stopped at the time limit",
			}),
		).toContain("stopped at its time limit");
	});

	it("says a no, and not to ask again", () => {
		const text = answerText({ state: "refused", why: "refused by Joel" });

		expect(text).toContain("Joel said no");
		expect(text).toContain("Don't ask again");
	});

	it("says any other end and that nothing ran", () => {
		expect(
			answerText({ state: "expired", why: "nobody answered in 10 minutes" }),
		).toBe(
			"The ask ended expired: nobody answered in 10 minutes. Nothing ran.",
		);
	});
});
