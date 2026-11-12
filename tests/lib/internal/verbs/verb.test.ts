import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fillVerb,
	parseVerb,
	readVerbs,
	verbRecord,
} from "../../../../lib/internal/verbs/verb.ts";

const SHORTEN = `---
words: Shorten
says: Say it in fewer words
result: replace
prompt: "Shorten this, for {{reader}}:\\n\\n{{selection}}"
args:
  - name: reader
    words: Who reads it
---
You shorten text. Answer with the shorter text alone.
`;

function parsed(id: string, text: string) {
	const read = parseVerb(id, text);
	if ("problem" in read) throw new Error(`refused: ${read.problem}`);
	return read.verb;
}

describe("a verb file", () => {
	it("says its words, result and arguments, with its body as the system prompt", () => {
		const verb = parsed("shorten", SHORTEN);
		expect(verb).toEqual({
			id: "shorten",
			words: "Shorten",
			says: "Say it in fewer words",
			result: "replace",
			disruptive: false,
			args: [{ name: "reader", words: "Who reads it" }],
			system: "You shorten text. Answer with the shorter text alone.",
			prompt: "Shorten this, for {{reader}}:\n\n{{selection}}",
		});
	});

	it("asks of the selection alone when it gives no prompt", () => {
		const verb = parsed(
			"explain",
			"---\nwords: Explain\nresult: say\n---\nExplain.\n",
		);
		expect(verb.prompt).toBe("{{selection}}");
		expect(verb.says).toBe("");
	});

	it.each([
		["no front matter", "Explain.\n", "it opens with no front matter"],
		["no words", "---\nresult: say\n---\nx\n", "it says no words"],
		[
			"an unknown result",
			"---\nwords: X\nresult: shout\n---\nx\n",
			"its result is shout, not say, replace or hand",
		],
		[
			"a place no argument fills",
			"---\nwords: X\nresult: say\nprompt: '{{tone}} {{selection}}'\n---\nx\n",
			"its prompt names tone, which no argument is",
		],
		[
			"an argument with no name",
			"---\nwords: X\nresult: say\nargs: [{words: Who}]\n---\nx\n",
			"an argument has no name",
		],
	])("is refused with %s", (_case, text, problem) => {
		expect(parseVerb("x", text)).toEqual({ problem });
	});

	it("is refused under a name that is no plain id", () => {
		expect(parseVerb("Fix It", SHORTEN)).toEqual({
			problem: "its name, Fix It, is not lower-case words joined by hyphens",
		});
	});
});

describe("filling a verb", () => {
	it("puts the selection and each argument in their places", () => {
		expect(
			fillVerb(parsed("shorten", SHORTEN), { reader: "Joel" }, "a long line"),
		).toEqual({ prompt: "Shorten this, for Joel:\n\na long line" });
	});

	it("leaves an argument not given empty", () => {
		expect(fillVerb(parsed("shorten", SHORTEN), {}, "x")).toEqual({
			prompt: "Shorten this, for :\n\nx",
		});
	});

	it("refuses an argument the verb doesn't take", () => {
		expect(fillVerb(parsed("shorten", SHORTEN), { tone: "warm" }, "x")).toEqual(
			{
				problem: "shorten takes no argument named tone",
			},
		);
	});

	it("puts a selection holding a place's braces in as it stands", () => {
		expect(
			fillVerb(
				parsed("shorten", SHORTEN),
				{ reader: "{{selection}}" },
				"{{reader}}",
			),
		).toEqual({ prompt: "Shorten this, for {{selection}}:\n\n{{reader}}" });
	});
});

describe("a verb's record", () => {
	it("is what the launcher lists, without its prompts", () => {
		expect(verbRecord(parsed("shorten", SHORTEN))).toEqual({
			key: "verb:shorten",
			kind: "verb",
			id: "shorten",
			words: "Shorten",
			says: "Say it in fewer words",
			result: "replace",
			disruptive: false,
			args: [{ name: "reader", words: "Who reads it" }],
		});
	});
});

describe("the package's verbs", () => {
	it("are each read without a problem", () => {
		const read = readVerbs([
			join(import.meta.dirname, "..", "..", "..", "..", "verbs"),
		]);
		expect(read.problems).toEqual([]);
		expect([...read.verbs.keys()].sort()).toEqual([
			"explain",
			"fix",
			"hand",
			"reply",
			"shorten",
		]);
	});
});

describe("reading verb folders", () => {
	let root = "";
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("takes a later folder's verb over an earlier one's by name, and says what it refused", () => {
		root = mkdtempSync(join(tmpdir(), "verbs-"));
		const shipped = join(root, "shipped");
		const own = join(root, "own");
		mkdirSync(shipped);
		mkdirSync(own);
		writeFileSync(
			join(shipped, "explain.md"),
			"---\nwords: Explain\nresult: say\n---\nx\n",
		);
		writeFileSync(join(shipped, "shorten.md"), SHORTEN);
		writeFileSync(join(shipped, "README.md"), "# Verbs\n");
		writeFileSync(
			join(own, "explain.md"),
			"---\nwords: Explain it\nresult: say\n---\ny\n",
		);
		writeFileSync(join(own, "broken.md"), "no front matter\n");

		const read = readVerbs([shipped, own, join(root, "missing")]);

		expect([...read.verbs.keys()].sort()).toEqual(["explain", "shorten"]);
		expect(read.verbs.get("explain")?.words).toBe("Explain it");
		expect(read.problems).toEqual([
			{
				file: join(own, "broken.md"),
				problem: "it opens with no front matter",
			},
		]);
	});
});
