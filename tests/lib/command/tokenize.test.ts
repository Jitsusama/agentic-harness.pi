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

	it("splits at top-level connectors into separate commands", () => {
		const line = tokenize("a && b ; c | d");

		expect(line.commands.map((c) => c.argv.map((w) => w.text))).toEqual([
			["a"],
			["b"],
			["c"],
			["d"],
		]);
		expect(line.connectors.map((c) => c.op)).toEqual(["&&", ";", "|"]);
	});

	it("does not split on a quoted operator", () => {
		const line = tokenize("echo 'a && b'");

		expect(line.commands).toHaveLength(1);
		expect(line.connectors).toEqual([]);
		expect(line.commands[0].argv.map((w) => w.text)).toEqual([
			"echo",
			"'a && b'",
		]);
	});

	it("separates leading env assignments from argv", () => {
		const command = tokenize("GH_HOST=github.com gh pr create").commands[0];

		expect(command.assignments.map((w) => w.text)).toEqual([
			"GH_HOST=github.com",
		]);
		expect(command.argv.map((w) => w.text)).toEqual(["gh", "pr", "create"]);
	});

	it("keeps a non-leading equals as an argv word", () => {
		const command = tokenize("git config user.email a=b").commands[0];

		expect(command.assignments).toEqual([]);
		expect(command.argv.map((w) => w.text)).toEqual([
			"git",
			"config",
			"user.email",
			"a=b",
		]);
	});

	it("captures a redirect with a following target out of argv", () => {
		const source = "echo hi > out.txt";
		const command = tokenize(source).commands[0];

		expect(command.argv.map((w) => w.text)).toEqual(["echo", "hi"]);
		expect(command.redirects).toHaveLength(1);
		expect(
			source.slice(command.redirects[0].start, command.redirects[0].end),
		).toBe("> out.txt");
	});

	it("captures a self-contained duplication redirect", () => {
		const source = "make 2>&1";
		const command = tokenize(source).commands[0];

		expect(command.argv.map((w) => w.text)).toEqual(["make"]);
		expect(command.redirects).toHaveLength(1);
		expect(
			source.slice(command.redirects[0].start, command.redirects[0].end),
		).toBe("2>&1");
	});

	it("attaches a heredoc and keeps its body out of argv", () => {
		const source = "git commit -F- <<'EOF'\nfeat: x\n\nbody\nEOF";
		const line = tokenize(source);
		const command = line.commands[0];

		expect(line.commands).toHaveLength(1);
		expect(line.connectors).toEqual([]);
		expect(command.argv.map((w) => w.text)).toEqual(["git", "commit", "-F-"]);
		expect(command.heredoc?.delimiter).toBe("EOF");
		expect(command.heredoc?.quoted).toBe(true);
		const body = command.heredoc?.bodySpan;
		expect(body && source.slice(body.start, body.end)).toBe("feat: x\n\nbody");
	});

	it("treats a bare heredoc delimiter as unquoted", () => {
		const source = "git commit -F- <<EOF\nmsg\nEOF";
		const command = tokenize(source).commands[0];

		expect(command.heredoc?.delimiter).toBe("EOF");
		expect(command.heredoc?.quoted).toBe(false);
	});

	it("joins across a backslash-newline continuation", () => {
		const line = tokenize("gh pr create \\\n  --title x");

		expect(line.commands).toHaveLength(1);
		expect(line.connectors).toEqual([]);
		expect(line.commands[0].argv.map((w) => w.text)).toEqual([
			"gh",
			"pr",
			"create",
			"--title",
			"x",
		]);
	});

	it("flags command substitution as unsupported", () => {
		const dollar = tokenize("echo $(date)");
		const backtick = tokenize("echo `date`");

		expect(dollar.supported).toBe(false);
		expect(dollar.unsupportedReason).toBeTruthy();
		expect(backtick.supported).toBe(false);
	});

	it("does not flag substitution that is quoted or in a heredoc body", () => {
		expect(tokenize("echo '$(date)'").supported).toBe(true);
		expect(tokenize("git commit -F- <<'EOF'\nsee $(date)\nEOF").supported).toBe(
			true,
		);
	});

	it("flags subshells, brace groups and control flow as unsupported", () => {
		expect(tokenize("(cd x && y)").supported).toBe(false);
		expect(tokenize("{ a ; }").supported).toBe(false);
		expect(tokenize("if true; then x; fi").supported).toBe(false);
		expect(tokenize("for f in a; do x; done").supported).toBe(false);
	});

	it("does not flag brace expansion or quoted parens", () => {
		expect(tokenize("echo '(ok)'").supported).toBe(true);
		expect(tokenize("echo {a,b}").supported).toBe(true);
	});

	it("splits on a background & so the next command is its own command", () => {
		const line = tokenize("git commit -m x & rm -rf y");

		expect(line.commands).toHaveLength(2);
		expect(line.connectors.map((c) => c.op)).toEqual(["&"]);
		expect(line.commands[1].argv[0].text).toBe("rm");
	});

	it("splits on |&", () => {
		const line = tokenize("a |& b");

		expect(line.commands).toHaveLength(2);
		expect(line.connectors.map((c) => c.op)).toEqual(["|&"]);
	});

	it("does not split &> as a connector", () => {
		expect(tokenize("echo a &>f").commands).toHaveLength(1);
	});

	it("keeps a double-quoted word whole across an escaped quote and does not swallow a later flag", () => {
		const argv = tokenize('gh pr create --title "a \\" b" --draft').commands[0]
			.argv;

		expect(argv.map((w) => w.text)).toEqual([
			"gh",
			"pr",
			"create",
			"--title",
			'"a \\" b"',
			"--draft",
		]);
	});
});
