/**
 * Which host a session moves into: attended when a person wrote in its
 * log, background otherwise, and the person's word over either.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostFor, personWrote } from "../../../host/cutover/attended.ts";
import { automatedText } from "../../../lib/internal/automated.ts";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "attended-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const user = (text: string) =>
	JSON.stringify({
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	});

const log = (...lines: string[]) => {
	const file = join(folder, "session.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
};

describe("personWrote", () => {
	it("finds words a person wrote among the harness's", async () => {
		const file = log(
			JSON.stringify({ type: "session", id: "s" }),
			user(automatedText("background work is reporting", "j1 exited 0")),
			user("ship it"),
		);
		expect(await personWrote(file), "ship it is a person's").toBe(true);
	});

	it("finds none where only the harness and peers wrote", async () => {
		const file = log(
			user(automatedText("the context was compacted", "Carry on.")),
			JSON.stringify({
				type: "custom_message",
				customType: "mesh",
				content: "hold",
			}),
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
			}),
		);
		expect(await personWrote(file), "none of these is a person's").toBe(false);
	});

	it("reads a plain string's content and passes over a torn line", async () => {
		const file = log(
			'{"type":"message","message":{"role":"user"',
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "." },
			}),
		);
		expect(await personWrote(file), "a lone dot is a person's").toBe(true);
	});

	it("reads lines that cross the chunks a log is read in", async () => {
		const result = JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: `${'"role":"user" '.repeat(9000)}` }],
			},
		});
		const long = automatedText("steer", "x".repeat(150_000));
		expect(
			await personWrote(log(result, user(long), result)),
			"the mark deep in a tool result is no user message",
		).toBe(false);
		expect(
			await personWrote(log(result, user(long), user("y".repeat(90_000)))),
			"a long line a person wrote, read across chunks",
		).toBe(true);
	});

	it("finds none in a log that isn't there", async () => {
		expect(
			await personWrote(join(folder, "gone.jsonl")),
			"a missing log holds no words",
		).toBe(false);
	});
});

describe("hostFor", () => {
	it("goes by the log when the person named nothing", () => {
		expect(hostFor(["AB12CD"], true).kind).toBe("attended");
		expect(hostFor(["AB12CD"], false).kind).toBe("background");
	});

	it("takes the person's word over the log, by any of its addresses", () => {
		const overrides = {
			attended: new Set(["EF34GH"]),
			background: new Set(["AB12CD"]),
		};
		expect(hostFor(["xy56zw", "ef34gh"], false, overrides)).toEqual({
			kind: "attended",
			why: "named attended (ef34gh)",
		});
		expect(hostFor(["AB12CD"], true, overrides)).toEqual({
			kind: "background",
			why: "named background (AB12CD)",
		});
	});
});
