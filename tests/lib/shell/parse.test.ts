import { describe, expect, it } from "vitest";
import {
	extractBody,
	extractFlag,
	hasUnquotedHeredoc,
	matchHeredocs,
	splitAtCommand,
	stripShellData,
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

describe("stripShellData", () => {
	it("drops a comment tail but keeps the commands around it", () => {
		const result = stripShellData("git commit # not-a-flag\ngit push");
		expect(result).toContain("git commit");
		expect(result).toContain("git push");
		expect(result).not.toContain("not-a-flag");
	});

	it("keeps a # mid-word after a backslash-newline continuation", () => {
		// The continuation joins the lines, so the # is not at a word
		// start and must not begin a comment.
		expect(stripShellData("a\\\n#x")).toBe("a#x");
	});

	it("does not treat a # inside single quotes as a comment", () => {
		// Quoted content is blanked, but the # is data, not a comment,
		// so the command after the quotes survives.
		expect(stripShellData("echo 'a # b' bar")).toBe("echo '' bar");
	});

	it("emits a trailing backslash so the skeleton keeps its shape", () => {
		expect(stripShellData("cmd \\")).toBe("cmd \\");
	});
});

describe("extractFlag", () => {
	it("survives the single-quote '\\'' idiom", () => {
		expect(extractFlag("--body 'it'\\''s here'", "body")).toBe("it's here");
	});

	it("unescapes double-quoted values", () => {
		expect(extractFlag('--title "a \\"q\\" b"', "title")).toBe('a "q" b');
	});

	it("reads a plain unquoted value", () => {
		expect(extractFlag("--body plain", "body")).toBe("plain");
	});

	it("returns null when the flag is absent", () => {
		expect(extractFlag("gh pr create", "body")).toBeNull();
	});
});

describe("splitAtCommand", () => {
	it("captures the full prefix across multiple separators", () => {
		const { prefix, target } = splitAtCommand(
			"cd /a && git add -A && git commit -m x",
			/git\s+commit\b/,
		);
		expect(prefix).toBe("cd /a && git add -A");
		expect(target).toBe("git commit -m x");
	});

	it("splits on a newline separator", () => {
		const { prefix } = splitAtCommand(
			"git checkout b\ngh pr create --body y",
			/gh\s+pr\s+create/,
		);
		expect(prefix).toBe("git checkout b");
	});

	it("returns a null prefix when there is no separator", () => {
		const { prefix, target } = splitAtCommand(
			"git commit -m x",
			/git\s+commit\b/,
		);
		expect(prefix).toBeNull();
		expect(target).toBe("git commit -m x");
	});
});

describe("hasUnquotedHeredoc", () => {
	it("is true for a bare delimiter and false for a quoted one", () => {
		expect(hasUnquotedHeredoc("cat <<EOF\nx\nEOF")).toBe(true);
		expect(hasUnquotedHeredoc("cat <<'EOF'\nx\nEOF")).toBe(false);
	});
});
