/**
 * The loader that lets a test import the shell script it runs, so
 * `--changed` follows an edit to that script alone to the test.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptsAsText } from "./scripts-as-text.ts";

const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** A shell script on disk with the text given. */
function script(text: string): string {
	const folder = mkdtempSync(join(tmpdir(), "scripts-as-text-"));
	folders.push(folder);
	const path = join(folder, "it.sh");
	writeFileSync(path, text);
	return path;
}

/** What the loader's module says by default, run as the module it is. */
async function moduleDefault(code: string): Promise<unknown> {
	const url = `data:text/javascript,${encodeURIComponent(code)}`;
	const loaded: unknown = await import(url);
	return typeof loaded === "object" && loaded !== null && "default" in loaded
		? loaded.default
		: undefined;
}

describe("scriptsAsText", () => {
	it("loads a shell script as a module whose default is its text", async () => {
		// Quotes, a backtick, a dollar and a backslash: what a script holds
		// and a module's string must keep as they are.
		const text = [
			"#!/usr/bin/env bash",
			`echo "it's \`here\`" $HOME \\n`,
			"",
		].join("\n");
		const code = scriptsAsText().load(script(text));

		expect(code, "a module for a .sh").toBeTypeOf("string");
		expect(await moduleDefault(code ?? "")).toBe(text);
	});

	it("leaves every other file to vite", () => {
		const loader = scriptsAsText();

		expect(loader.load(join(import.meta.dirname, "temp-root.ts"))).toBeNull();
		expect(loader.load("/x/it.sh?raw"), "a query is vite's own").toBeNull();
	});

	it("runs before vite's own loading, which would read a script as JavaScript", () => {
		expect(scriptsAsText().enforce).toBe("pre");
	});
});
