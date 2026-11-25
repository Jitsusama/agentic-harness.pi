import { describe, expect, it } from "vitest";
import {
	FAILED_RESUME_TEXT,
	FAILED_WAITING_TEXT,
	isResumeText,
	RESUME_TEXT,
	WAITING_TEXT,
} from "../../../lib/compaction/resume.ts";
import {
	automatedHeader,
	automatedText,
	isAutomatedText,
	isSpawnedText,
	START_WORDS_REASON,
	startWordsOf,
} from "../../../lib/internal/automated.ts";
import { spawnedWords } from "../../../lib/internal/quest/sessions/first-words.ts";
import { isOutboxMessage, OUTBOX_HEADER } from "../../../lib/jobs/report.ts";

describe("the turns the harness starts itself", () => {
	it("opens each with one header that says why", () => {
		expect(automatedText("the context was compacted", "Carry on.")).toBe(
			"[Automated message, no human input: the context was compacted.] Carry on.",
		);
	});

	it("recognises every one of them, whoever sent it", () => {
		for (const text of [RESUME_TEXT, FAILED_RESUME_TEXT, OUTBOX_HEADER]) {
			expect(
				isAutomatedText(`${text}\n\n[quest context]`),
				`a turn opening ${JSON.stringify(text)} reads as automated`,
			).toBe(true);
		}
	});

	it("gives the job host its header, and still knows the one before", () => {
		expect(OUTBOX_HEADER).toBe(
			"[Automated message, no human input: background work is reporting.]",
		);
		expect(automatedHeader("background work is reporting")).toBe(OUTBOX_HEADER);
		// A result sent just before a reload reaches the code loaded after.
		expect(
			isOutboxMessage(automatedHeader("background jobs are reporting")),
			"the older background jobs header still reads as a job report",
		).toBe(true);
	});

	it("still recognises what the harness sent before the header", () => {
		for (const legacy of [
			"The context was compacted to keep this session affordable. Carry on.",
			"Compacting the context failed, so it was left as it is. Carry on.",
			"Verification found 3 errors in files you changed this turn.",
		]) {
			expect(
				isAutomatedText(legacy),
				`${JSON.stringify(legacy)}, sent before the header, reads as automated`,
			).toBe(true);
		}
		expect(
			isResumeText(
				"The context was compacted to keep this session affordable. Carry on.",
			),
			"the resume sent before the header still reads as a resume",
		).toBe(true);
	});

	it("leaves what a person typed alone", () => {
		expect(
			isAutomatedText("please fix the verification"),
			"a typed request naming the verification is a person's",
		).toBe(false);
		expect(
			isAutomatedText("[Automated message] is what I'd call it"),
			"a typed line that only borrows the header's words is a person's",
		).toBe(false);
	});

	it("tells a resume from a job report", () => {
		expect(isResumeText(RESUME_TEXT), "the resume reads as a resume").toBe(
			true,
		);
		expect(
			isResumeText(FAILED_RESUME_TEXT),
			"the resume after a failed compaction reads as a resume",
		).toBe(true);
		expect(
			isResumeText(OUTBOX_HEADER),
			"a job report does not read as a resume",
		).toBe(false);
	});

	it("reads back the words a session's start left it, and only those", () => {
		const words = automatedText(START_WORDS_REASON, "Quest QEST-1 is made.");
		expect(isAutomatedText(words)).toBe(true);
		expect(startWordsOf(`\n${words}`)).toBe("Quest QEST-1 is made.");
		expect(startWordsOf(automatedText("a job finished", "Quest"))).toBe(
			undefined,
		);
		expect(startWordsOf("Quest QEST-1 is made.")).toBe(undefined);
	});

	// A spawn's words hold what the session was started for, as a
	// sprout's do, so the readers keep them as the start's.
	it("reads a quest spawn's words as its start's, as a spawn writes them", () => {
		const words = spawnedWords("QEST-1", "Fix the drawer.");
		const body = startWordsOf(words);
		expect(body, "a spawn's words read as the start's").toMatch(
			/^Carry on with QEST-1: /u,
		);
		expect(body).toMatch(/What it was started for:\n\nFix the drawer\.$/u);
		expect(
			startWordsOf(
				automatedText("quest spawn started this session on two words", "x"),
			),
			"a header naming no quest id isn't a spawn's",
		).toBe(undefined);
	});

	// Written out as a spawn has logged them since before the reader, so
	// a change to the writer can't make this pass by itself.
	it("reads a spawn's words as a log on disk holds them", () => {
		const logged =
			"[Automated message, no human input: quest spawn started this session on QEST-20261116-42P0R4.] Carry on with QEST-20261116-42P0R4: read its README.";
		expect(startWordsOf(logged)).toBe(
			"Carry on with QEST-20261116-42P0R4: read its README.",
		);
		expect(startWordsOf(`\n  ${logged}`), "leading space aside").toBe(
			"Carry on with QEST-20261116-42P0R4: read its README.",
		);
		expect(isSpawnedText(logged)).toBe(true);
		expect(isSpawnedText(automatedText(START_WORDS_REASON, "x"))).toBe(false);
	});

	it("keeps a spawn's body whole when it holds a header's close itself", () => {
		const words = spawnedWords("QEST-1", "Say [it.] then stop.");
		expect(startWordsOf(words)).toMatch(/Say \[it\.\] then stop\.$/u);
	});

	it("reads no start in a spawn header that names nothing or never closes", () => {
		const opening =
			"[Automated message, no human input: quest spawn started this session on ";
		expect(startWordsOf(`${opening}.] Carry on.`), "no quest id").toBe(
			undefined,
		);
		expect(startWordsOf(`${opening}QEST-1 Carry on.`), "no close").toBe(
			undefined,
		);
		expect(isSpawnedText(`${opening}.] Carry on.`)).toBe(false);
	});

	// A reopened session's log already holds its start, so the words a
	// spawn sends into it midway are the harness's turn, never a start.
	it("reads a spawn's words into a reopened session as no start", () => {
		const words = spawnedWords("QEST-1", "Fix the drawer.", true);
		expect(startWordsOf(words)).toBe(undefined);
		expect(isSpawnedText(words)).toBe(false);
		expect(isAutomatedText(words)).toBe(true);
		expect(words).toMatch(/Fix the drawer\.$/u);
	});

	it("reads a run for messages that waited as automated, not as a resume", () => {
		for (const text of [WAITING_TEXT, FAILED_WAITING_TEXT]) {
			expect(isResumeText(text), text).toBe(false);
			expect(isAutomatedText(text), text).toBe(true);
		}
	});
});
