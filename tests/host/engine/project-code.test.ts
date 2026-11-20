import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	codeStanding,
	PINS_FILE,
	pin,
	projectCode,
	unpinnedSaying,
} from "../../../host/engine/project-code.ts";

let root: string;
let folder: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "project-code-"));
	folder = join(root, "tree");
	agentDir = join(root, "agent");
	mkdirSync(folder);
	mkdirSync(agentDir);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(place: string, text: string): void {
	const path = join(folder, place);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

/** A clock that starts the pins after everything already written. */
const later = () => Date.now() + 60_000;
/** A clock that starts the pins before anything is written. */
const earlier = () => 0;

describe("the code a folder's .pi holds", () => {
	it("is none for words alone: skills, prompts and themes", () => {
		write(".pi/skills/a/SKILL.md", "words");
		write(".pi/prompts/dream.md", "words");
		write(".pi/themes/dark.json", "{}");
		expect(projectCode(folder)).toBeUndefined();
	});

	it("counts extensions, MCP servers, installed packages and settings that run code", () => {
		write(".pi/extensions/lint.ts", "export default () => {}");
		write(".pi/mcp.json", "{}");
		write(".pi/npm/node_modules/p/index.js", "");
		write(".pi/git/github.com/o/r/index.ts", "");
		write(".pi/settings.json", JSON.stringify({ packages: ["npm:p"] }));
		expect(projectCode(folder)?.files).toEqual([
			".pi/extensions/lint.ts",
			".pi/mcp.json",
			".pi/npm/node_modules/p/index.js",
			".pi/git/github.com/o/r/index.ts",
			".pi/settings.json",
		]);
	});

	it("is none for settings that change how pi behaves, not what runs", () => {
		write(
			".pi/settings.json",
			JSON.stringify({ compaction: { keepRecentTokens: 9 } }),
		);
		expect(projectCode(folder)).toBeUndefined();
	});

	it("changes when a setting that runs code changes, and not for one that doesn't", () => {
		write(
			".pi/settings.json",
			JSON.stringify({ shellPath: "/bin/sh", theme: "a" }),
		);
		const before = projectCode(folder)?.digest;
		write(
			".pi/settings.json",
			JSON.stringify({ shellPath: "/bin/sh", theme: "b" }),
		);
		expect(projectCode(folder)?.digest).toBe(before);
		write(
			".pi/settings.json",
			JSON.stringify({ shellPath: "/tmp/sh", theme: "b" }),
		);
		expect(projectCode(folder)?.digest).not.toBe(before);
	});

	it("counts settings it can't read whole", () => {
		write(".pi/settings.json", "{ not json");
		expect(projectCode(folder)?.files).toEqual([".pi/settings.json"]);
	});

	it("changes when a file's contents change", () => {
		write(".pi/extensions/lint.ts", "one");
		const before = projectCode(folder)?.digest;
		write(".pi/extensions/lint.ts", "two");
		expect(projectCode(folder)?.digest).not.toBe(before);
	});

	it("follows a link to the file pi would load, and counts where it leads", () => {
		writeFileSync(join(root, "one.ts"), "one");
		writeFileSync(join(root, "two.ts"), "one");
		mkdirSync(join(folder, ".pi/extensions"), { recursive: true });
		const link = join(folder, ".pi/extensions/lint.ts");
		symlinkSync(join(root, "one.ts"), link);
		const before = projectCode(folder);
		expect(before?.files).toEqual([".pi/extensions/lint.ts"]);
		rmSync(link);
		symlinkSync(join(root, "two.ts"), link);
		expect(projectCode(folder)?.digest).not.toBe(before?.digest);
	});
});

describe("whether a folder's code may load", () => {
	it("needs nothing where there is no code", () => {
		write(".pi/skills/a/SKILL.md", "words");
		expect(codeStanding(folder, agentDir, later).kind).toBe("none");
	});

	it("pins code already there when the host first looks, and starts its pins", () => {
		write(".pi/extensions/lint.ts", "one");
		expect(codeStanding(folder, agentDir, later).kind).toBe("pinned");
		const pins: unknown = JSON.parse(
			readFileSync(join(agentDir, PINS_FILE), "utf8"),
		);
		expect(pins).toMatchObject({
			folders: { [folder]: projectCode(folder)?.digest },
		});
	});

	it("doesn't pin code that arrived after the pins began", () => {
		write(".pi/extensions/lint.ts", "one");
		expect(codeStanding(folder, agentDir, earlier).kind).toBe("unpinned");
	});

	/** Pins begun before anything was written, with the folder's code as it stands allowed. */
	function allowed(): void {
		codeStanding(folder, agentDir, earlier);
		const code = projectCode(folder);
		if (!code) throw new Error("the folder should hold code");
		pin(folder, agentDir, code);
	}

	it("loads pinned code while it stays as it was", () => {
		write(".pi/extensions/lint.ts", "one");
		allowed();
		expect(codeStanding(folder, agentDir).kind).toBe("pinned");
	});

	it("doesn't load pinned code once it changes", () => {
		write(".pi/extensions/lint.ts", "one");
		allowed();
		write(".pi/extensions/lint.ts", "two");
		expect(codeStanding(folder, agentDir).kind).toBe("unpinned");
	});

	it("doesn't load a file added beside pinned code", () => {
		write(".pi/extensions/lint.ts", "one");
		allowed();
		write(".pi/extensions/more.ts", "planted");
		expect(codeStanding(folder, agentDir).kind).toBe("unpinned");
	});

	it("doesn't load code planted in a folder that had none", () => {
		write(".pi/skills/a/SKILL.md", "words");
		codeStanding(folder, agentDir, earlier);
		write(".pi/extensions/planted.ts", "planted");
		expect(codeStanding(folder, agentDir).kind).toBe("unpinned");
	});

	it("refuses pins it can't read rather than load past them", () => {
		write(".pi/extensions/lint.ts", "one");
		writeFileSync(join(agentDir, PINS_FILE), "[]");
		expect(() => codeStanding(folder, agentDir)).toThrow(
			"isn't the host's project code pins",
		);
	});
});

describe("what is said of code that may not load", () => {
	it("names the folder and a few of its files", () => {
		for (const name of ["a", "b", "c", "d", "e"])
			write(`.pi/extensions/${name}.ts`, name);
		const code = projectCode(folder);
		if (!code) throw new Error("the folder should hold code");
		expect(unpinnedSaying(folder, code)).toBe(
			`${folder}'s .pi holds code pi would run outside the sandbox (.pi/extensions/a.ts, .pi/extensions/b.ts, .pi/extensions/c.ts and 2 more) that is new or changed since it was last allowed`,
		);
	});
});
