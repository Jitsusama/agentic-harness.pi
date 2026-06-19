import { describe, expect, it } from "vitest";
import { tokenize } from "../../../lib/command/index.js";

describe("tokenize", () => {
	it("yields no commands for an empty command", () => {
		const line = tokenize("");

		expect(line.source).toBe("");
		expect(line.commands).toEqual([]);
		expect(line.connectors).toEqual([]);
		expect(line.supported).toBe(true);
	});

	it("captures the argv words of a single simple command", () => {
		const line = tokenize("git status");

		expect(line.commands).toHaveLength(1);
		expect(line.commands[0].argv.map((w) => w.text)).toEqual(["git", "status"]);
	});

	it("keeps a single-quoted argument as one word with its quote style", () => {
		const source = "echo 'a b'";
		const word = tokenize(source).commands[0].argv[1];

		expect(word.text).toBe("'a b'");
		expect(word.quoting).toBe("single");
		expect(source.slice(word.span.start, word.span.end)).toBe(word.text);
	});

	it("keeps a double-quoted argument as one word with its quote style", () => {
		const source = 'echo "a b"';
		const word = tokenize(source).commands[0].argv[1];

		expect(word.text).toBe('"a b"');
		expect(word.quoting).toBe("double");
		expect(source.slice(word.span.start, word.span.end)).toBe(word.text);
	});
});
