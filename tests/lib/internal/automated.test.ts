import { describe, expect, it } from "vitest";
import { OUTBOX_HEADER } from "../../../extensions/job-workflow/outbox.ts";
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
			expect(isAutomatedText(`${text}\n\n[quest context]`)).toBe(true);
		}
	});

	it("gives the job host the header it always had", () => {
		expect(OUTBOX_HEADER).toBe(
			"[Automated message, no human input: background jobs are reporting.]",
		);
		expect(automatedHeader("background jobs are reporting")).toBe(
			OUTBOX_HEADER,
		);
	});

	it("still recognises what the harness sent before the header", () => {
		for (const legacy of [
			"The context was compacted to keep this session affordable. Carry on.",
			"Compacting the context failed, so it was left as it is. Carry on.",
			"Verification found 3 errors in files you changed this turn.",
		]) {
			expect(isAutomatedText(legacy)).toBe(true);
		}
		expect(
			isResumeText(
				"The context was compacted to keep this session affordable. Carry on.",
			),
		).toBe(true);
	});

	it("leaves what a person typed alone", () => {
		expect(isAutomatedText("please fix the verification")).toBe(false);
		expect(isAutomatedText("[Automated message] is what I'd call it")).toBe(
			false,
		);
	});

	it("tells a resume from a job report", () => {
		expect(isResumeText(RESUME_TEXT)).toBe(true);
		expect(isResumeText(FAILED_RESUME_TEXT)).toBe(true);
		expect(isResumeText(OUTBOX_HEADER)).toBe(false);
	});
});
