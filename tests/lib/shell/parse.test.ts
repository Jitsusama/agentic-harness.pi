import { describe, expect, it } from "vitest";
import {
	extractBody,
	matchHeredocs,
	unquote,
} from "../../../lib/shell/parse.js";

describe("unquote", () => {
	it("leaves an unquoted word untouched", () => {
		expect(unquote("value")).toBe("value");
	});

	it("strips double quotes and unescapes inside them", () => {
		expect(unquote('"a b"')).toBe("a b");
		expect(unquote('"a \\"b\\""')).toBe('a "b"');
	});

	it("strips single quotes and keeps their contents literal", () => {
		expect(unquote("'a b'")).toBe("a b");
		expect(unquote("'a\\b'")).toBe("a\\b");
	});

	it("joins the '\\'' idiom into an embedded single quote", () => {
		expect(unquote("'it'\\''s'")).toBe("it's");
	});

	it("concatenates adjacent quoted and bare runs", () => {
		expect(unquote('foo"bar baz"')).toBe("foobar baz");
	});
});

describe("matchHeredocs", () => {
	it("returns nothing when there is no heredoc", () => {
		expect(matchHeredocs('echo "hi"')).toEqual([]);
	});

	it("captures body and quote-state for a quoted delimiter", () => {
		const command = "git commit -F- <<'EOF'\nmessage\nEOF";
		const matches = matchHeredocs(command);
		expect(matches).toHaveLength(1);
		expect(matches[0].delim).toBe("EOF");
		expect(matches[0].body).toBe("message");
		expect(matches[0].quoted).toBe(true);
	});

	it("reports an unquoted delimiter", () => {
		expect(matchHeredocs("cmd <<EOF\nx\nEOF")[0].quoted).toBe(false);
	});

	it("returns every heredoc in order with spans", () => {
		const command = "a <<'A'\naaa\nA\nb <<'B'\nbbb\nB";
		const matches = matchHeredocs(command);
		expect(matches.map((m) => m.delim)).toEqual(["A", "B"]);
		expect(matches.map((m) => m.body)).toEqual(["aaa", "bbb"]);
		expect(
			command.slice(matches[0].index, matches[0].index + matches[0].length),
		).toContain("aaa");
	});

	it("stops at the bare delimiter line, ignoring inline mentions", () => {
		const command = "x <<'EOF'\nhas EOF inline\nreal\nEOF";
		expect(matchHeredocs(command)[0].body).toBe("has EOF inline\nreal");
	});

	it("parses an opener line with trailing redirects and pipes", () => {
		const command =
			"gh pr edit 42 --body-file - <<'EOF' 2>&1 | tail -5\nBody.\nEOF";
		const matches = matchHeredocs(command);
		expect(matches).toHaveLength(1);
		expect(matches[0].body).toBe("Body.");
		expect(matches[0].openerRest).toBe(" 2>&1 | tail -5");
	});

	it("reports an empty openerRest for a plain opener line", () => {
		const command = "cmd <<'EOF'\nbody\nEOF";
		expect(matchHeredocs(command)[0].openerRest).toBe("");
	});
});

describe("extractBody", () => {
	it("returns the heredoc body when no content follows the delimiter", () => {
		const command = "gh pr create --body-file - <<'EOF'\nHello.\nEOF";
		expect(extractBody(command, command)).toBe("Hello.");
	});

	it("returns the heredoc body when shell tokens follow the closing delimiter", () => {
		const command =
			"gh pr create --body-file - <<'EOF'\nBody line one.\nBody line two.\nEOF\n && git push";
		expect(extractBody(command, command)).toBe(
			"Body line one.\nBody line two.",
		);
	});

	it("stops at the real closing delimiter when the body mentions other heredoc tokens", () => {
		const command =
			"gh pr edit --body-file - <<'EOF'\nSee the SYSTEMD_EOF heredoc below.\nMore body.\nEOF\n && echo done";
		expect(extractBody(command, command)).toBe(
			"See the SYSTEMD_EOF heredoc below.\nMore body.",
		);
	});

	it("falls back to the --body flag when there is no heredoc", () => {
		const command = 'gh pr create --body "Plain body."';
		expect(extractBody(command, command)).toBe("Plain body.");
	});
});
