import { beforeEach, describe, expect, it } from "vitest";
import {
	FIRST_PROMPT_MS,
	firstPromptPending,
	givesFirstPrompt,
	runStarted,
} from "../../../../lib/internal/session/first-prompt.ts";

beforeEach(() => {
	delete (globalThis as Record<symbol, unknown>)[
		Symbol.for("agentic-harness.pi/first-prompt")
	];
});

describe("pi's first prompt", () => {
	it("is given by words on the command line, as pi's parser reads them", () => {
		expect(givesFirstPrompt(["--session", "01a1", "--", "Carry on"])).toBe(
			true,
		);
		expect(givesFirstPrompt(["Carry on"])).toBe(true);
		expect(givesFirstPrompt(["--session", "01a1"])).toBe(false);
		expect(givesFirstPrompt(["--session-id", "01a1", "--model", "x"])).toBe(
			false,
		);
	});

	it("is pending until a run starts", () => {
		const args = ["--session", "01a1", "--", "Carry on"];
		expect(firstPromptPending(args, 1_000)).toBe(true);
		runStarted();
		expect(firstPromptPending(args, 1_000)).toBe(false);
	});

	it("is taken to have gone nowhere once the process has run a while", () => {
		const args = ["Carry on"];
		expect(firstPromptPending(args, FIRST_PROMPT_MS - 1)).toBe(true);
		expect(firstPromptPending(args, FIRST_PROMPT_MS)).toBe(false);
	});

	it("is never pending for a session started without words", () => {
		expect(firstPromptPending(["--session", "01a1"], 1_000)).toBe(false);
	});
});
