/**
 * The session-file readers the host cases wait on, read from files
 * written as pi writes them. `answeredLast` is what restart-carry's
 * count after the next host's word of a command's end waits on, and the
 * cases that use it run only on a host, so this is where it is held.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STEERED_RESULTS } from "../../../../extensions/job-workflow/outbox.ts";
import { answeredLast } from "./hosted-case.ts";

let folder: string | undefined;

afterEach(() => {
	if (folder) rmSync(folder, { recursive: true, force: true });
	folder = undefined;
});

/** A session file holding `entries`, one JSON line each, as pi writes. */
function sessionOf(...entries: object[]): string {
	folder = mkdtempSync(join(tmpdir(), "hosted-case-"));
	const file = join(folder, "session.jsonl");
	writeFileSync(
		file,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return file;
}

/** A message entry with `message`. */
function said(message: object): object {
	return { type: "message", message };
}

const told = said({ role: "user", content: "carry" });
const answered = said({
	role: "assistant",
	content: [{ type: "text", text: "sent" }],
	stopReason: "stop",
});
const calling = said({
	role: "assistant",
	content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }],
	stopReason: "toolUse",
});
const steered = {
	type: "custom_message",
	customType: STEERED_RESULTS,
	content: "[j1] the command exited 0 after 46 seconds.",
	display: true,
};

describe("answeredLast", () => {
	it("holds once the model's last answer calls no tool", () => {
		expect(answeredLast(sessionOf(told, answered))).toBe(true);
	});

	it("waits while the model's last message calls a tool", () => {
		expect(answeredLast(sessionOf(told, calling))).toBe(false);
	});

	it("waits while words wait for the model", () => {
		expect(answeredLast(sessionOf(answered, told))).toBe(false);
	});

	it("waits on a job's end steered into the run after its answer", () => {
		expect(answeredLast(sessionOf(told, answered, steered))).toBe(false);
	});

	it("holds once the model answers after the steered end", () => {
		expect(answeredLast(sessionOf(told, answered, steered, answered))).toBe(
			true,
		);
	});

	it("passes over another extension's custom message", () => {
		const note = {
			type: "custom_message",
			customType: "some-note",
			content: "noted",
			display: true,
		};
		expect(answeredLast(sessionOf(told, answered, note))).toBe(true);
	});

	it("passes over entries that aren't said, such as a mark", () => {
		const mark = { type: "custom", customType: "job-carried", data: {} };
		expect(answeredLast(sessionOf(told, answered, mark))).toBe(true);
	});

	it("waits on an answer that stopped on an error, which may be retried", () => {
		const failed = said({
			role: "assistant",
			content: [],
			stopReason: "error",
		});
		expect(answeredLast(sessionOf(told, failed))).toBe(false);
	});

	it("waits on a file not written yet", () => {
		expect(answeredLast(undefined)).toBe(false);
	});
});
