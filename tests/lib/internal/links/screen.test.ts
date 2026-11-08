import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	Markdown,
	type MarkdownTheme,
	stripTerminalSequences,
	Text,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { linkAtClick } from "../../../../lib/internal/links/resolve.ts";
import type { PlaceWorld } from "../../../../lib/internal/links/targets.ts";

const colour =
	(code: number) =>
	(text: string): string =>
		`\x1b[${code}m${text}\x1b[39m`;

/** A theme that styles everything, so every row is full of escapes. */
const theme: MarkdownTheme = {
	heading: colour(35),
	link: colour(34),
	linkUrl: colour(36),
	code: colour(33),
	codeBlock: colour(32),
	codeBlockBorder: colour(90),
	quote: colour(37),
	quoteBorder: colour(90),
	hr: colour(90),
	listBullet: colour(36),
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => `\x1b[3m${text}\x1b[23m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	underline: (text) => `\x1b[4m${text}\x1b[24m`,
};

let world: PlaceWorld;
let deep: string;

beforeEach(() => {
	const home = mkdtempSync(join(tmpdir(), "links-screen-"));
	const quest = join(home, "quests", "QEST-20261104-YJJEPK");
	mkdirSync(quest, { recursive: true });
	writeFileSync(join(quest, "README.md"), "#");
	deep = join(home, "a-folder-with-a-long-name", "and-another-one-below");
	mkdirSync(deep, { recursive: true });
	deep = join(deep, "the-notes-at-the-bottom.md");
	writeFileSync(deep, "#");
	world = {
		home,
		questsRoot: join(home, "quests"),
		originRepo: () => ({ owner: "Jitsusama", repo: "agentic-harness.pi" }),
	};
});

/** Where `needle` sits on a screen: its row and the column of its first cell. */
function cellOf(screen: readonly string[], needle: string) {
	for (const [row, line] of screen.entries()) {
		const column = stripTerminalSequences(line).indexOf(needle);
		if (column >= 0) return { x: column, y: row };
	}
	throw new Error(`${needle} is not on the screen:\n${screen.join("\n")}`);
}

function clickOn(screen: readonly string[], needle: string, columns: number) {
	const { x, y } = cellOf(screen, needle);
	return linkAtClick(screen, x, y, columns, world);
}

const URL_TOO_LONG =
	"https://github.com/Jitsusama/agentic-harness.pi/pull/959/files#diff-0123456789";

describe("a click on what pi's components draw", () => {
	it("opens a URL that Text broke across rows, from any of its rows", () => {
		const width = 30;
		const screen = new Text(`fetched ${URL_TOO_LONG} done`, 1, 0).render(width);
		expect(screen.length).toBeGreaterThan(3);
		for (const piece of ["https://github", "agentic", "0123456789"]) {
			expect(clickOn(screen, piece, width)).toBe(URL_TOO_LONG);
		}
	});

	it("opens a path in a code span that Markdown broke across rows", () => {
		const width = 34;
		const screen = new Markdown(
			`Wrote \`${deep}\` just now.`,
			1,
			0,
			theme,
		).render(width);
		expect(screen).toContainEqual(expect.stringContaining("\x1b[33m"));
		expect(clickOn(screen, "and-another", width)).toBe(
			pathToFileURL(deep).href,
		);
		expect(clickOn(screen, "bottom", width)).toBe(pathToFileURL(deep).href);
	});

	it("opens a path broken across rows of a narrow column, which it checks", () => {
		const screen = new Text(deep, 0, 0)
			.render(24)
			.map((line) => `${line}${" ".repeat(56)}`);
		expect(clickOn(screen, "bottom", 80)).toBe(pathToFileURL(deep).href);
	});

	it("opens a quest id in a list item, and a bare number in the repo", () => {
		const width = 60;
		const screen = new Markdown(
			"- on `QEST-20261104-YJJEPK`\n- fixed in #959",
			1,
			0,
			theme,
		).render(width);
		expect(clickOn(screen, "YJJEPK", width)).toBe(
			pathToFileURL(join(world.questsRoot, "QEST-20261104-YJJEPK", "README.md"))
				.href,
		);
		expect(clickOn(screen, "959", width)).toBe(
			"https://github.com/Jitsusama/agentic-harness.pi/issues/959",
		);
	});

	it("does not join a URL to the word after it on the next row", () => {
		const width = 40;
		const screen = new Text(
			"see the page https://example.com/a/b/c and then the next words",
			1,
			0,
		).render(width);
		expect(clickOn(screen, "example", width)).toBe("https://example.com/a/b/c");
	});

	it("does not join URLs listed one to a row", () => {
		const width = 40;
		const screen = new Text(
			"https://example.com/first\nhttps://example.com/second",
			1,
			0,
		).render(width);
		expect(clickOn(screen, "first", width)).toBe("https://example.com/first");
		expect(clickOn(screen, "second", width)).toBe("https://example.com/second");
	});

	it("counts wide characters as the two cells they take", () => {
		const width = 40;
		const screen = new Text("日本語 https://example.com/x", 0, 0).render(width);
		expect(clickOn(screen, "example", width)).toBe("https://example.com/x");
	});

	it("opens nothing on plain words, a blank cell or a path that isn't there", () => {
		const width = 40;
		const screen = new Text("plain words and /no/such/file.md", 1, 0).render(
			width,
		);
		expect(clickOn(screen, "words", width)).toBeUndefined();
		expect(clickOn(screen, "/no/such", width)).toBeUndefined();
		expect(linkAtClick(screen, 0, 0, width, world)).toBeUndefined();
		expect(linkAtClick(screen, 5, 9, width, world)).toBeUndefined();
	});

	it("answers a click on a long screen in well under a frame", () => {
		const width = 120;
		const screen = new Markdown(
			Array.from(
				{ length: 300 },
				(_, i) => `Line ${i}: see \`${deep}\` and ${URL_TOO_LONG}/${i}.`,
			).join("\n\n"),
			1,
			0,
			theme,
		).render(width);
		const { x, y } = cellOf(screen.slice(400), "and-another");
		const started = performance.now();
		const link = linkAtClick(screen, x, y + 400, width, world);
		const took = performance.now() - started;
		expect(link).toBe(pathToFileURL(deep).href);
		expect(took).toBeLessThan(16);
	});
});
