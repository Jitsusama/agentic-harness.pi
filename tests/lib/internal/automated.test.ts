import { describe, expect, it } from "vitest";
import {
	isOutboxMessage,
	OUTBOX_HEADER,
} from "../../../extensions/job-workflow/outbox.ts";
import {
	FAILED_RESUME_TEXT,
	isResumeText,
	RESUME_TEXT,
} from "../../../lib/compaction/resume.ts";
import {
	automatedHeader,
	automatedText,
	isAutomatedText,
} from "../../../lib/internal/automated.ts";

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
});
