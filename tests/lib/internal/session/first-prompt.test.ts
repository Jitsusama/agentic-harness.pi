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
		expect(
			givesFirstPrompt(["--session", "01a1", "--", "Carry on"]),
			"words after -- give a first prompt",
		).toBe(true);
		expect(
			givesFirstPrompt(["Carry on"]),
			"words alone give a first prompt",
		).toBe(true);
		expect(
			givesFirstPrompt(["--session", "01a1"]),
			"a flag and its value give no first prompt",
		).toBe(false);
		expect(
			givesFirstPrompt(["--session-id", "01a1", "--model", "x"]),
			"flags and their values give no first prompt",
		).toBe(false);
	});

	it("is pending until a run starts", () => {
		const args = ["--session", "01a1", "--", "Carry on"];
		expect(
			firstPromptPending(args, 1_000),
			"the first prompt is pending before any run",
		).toBe(true);
		runStarted();
		expect(
			firstPromptPending(args, 1_000),
			"the first prompt is no longer pending once a run starts",
		).toBe(false);
	});

	it("is taken to have gone nowhere once the process has run a while", () => {
		const args = ["Carry on"];
		expect(
			firstPromptPending(args, FIRST_PROMPT_MS - 1),
			"the first prompt is pending just under FIRST_PROMPT_MS in",
		).toBe(true);
		expect(
			firstPromptPending(args, FIRST_PROMPT_MS),
			"the first prompt has gone nowhere at FIRST_PROMPT_MS",
		).toBe(false);
	});

	it("is never pending for a session started without words", () => {
		expect(
			firstPromptPending(["--session", "01a1"], 1_000),
			"nothing is pending for a session started without words",
		).toBe(false);
	});
});
