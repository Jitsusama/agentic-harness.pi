import { describe, expect, it } from "vitest";
import { extractMessage } from "../../../../lib/internal/guardian/shell.js";

describe("extractMessage", () => {
	it("reads a heredoc body", () => {
		expect(extractMessage("git commit -F- <<'EOF'\nThe message.\nEOF")).toBe(
			"The message.",
		);
	});

	it("reads a -m flag", () => {
		expect(extractMessage('git commit -m "subject"')).toBe("subject");
	});

	it("joins repeated -m flags into paragraphs", () => {
		expect(extractMessage('git commit -m "subject" -m "body"')).toBe(
			"subject\n\nbody",
		);
	});

	it("reads the message from an -am cluster", () => {
		expect(extractMessage('git commit -am "subject"')).toBe("subject");
	});

	it("ignores a heredoc that belongs to a chained command", () => {
		expect(
			extractMessage(
				"git commit -m \"real\" && cat <<'EOF'\nnot the message\nEOF",
			),
		).toBe("real");
	});

	it("resolves a -F <file> through the injected reader with the cd base", () => {
		const calls: Array<[string, string | null]> = [];
		const read = (path: string, base: string | null): string | null => {
			calls.push([path, base]);
			return "body from file";
		};
		const message = extractMessage(
			"cd /work && git commit -F msg.txt 2>&1 | tail -3",
			read,
		);
		expect(message).toBe("body from file");
		expect(calls).toEqual([["msg.txt", "/work"]]);
	});

	it("passes the process cwd as the base when there is no cd", () => {
		const calls: Array<[string, string | null]> = [];
		const read = (path: string, base: string | null): string | null => {
			calls.push([path, base]);
			return "x";
		};
		extractMessage("git commit -F /tmp/m.txt", read);
		expect(calls).toEqual([["/tmp/m.txt", process.cwd()]]);
	});

	it("returns null for a -F file when no reader is given", () => {
		expect(extractMessage("git commit -F /tmp/m.txt")).toBeNull();
	});

	it("does not treat -F - (stdin) as a file", () => {
		const read = (): string | null => "should not be used";
		expect(extractMessage("git commit -F -", read)).toBeNull();
	});

	it("returns null when the reader cannot read the file", () => {
		const read = (): string | null => null;
		expect(extractMessage("git commit -F /tmp/missing.txt", read)).toBeNull();
	});
});
