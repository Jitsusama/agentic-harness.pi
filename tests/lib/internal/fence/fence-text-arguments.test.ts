/**
 * A fence's text can hold Delta's token, so the bash that runs it is
 * handed the text in a variable, never as an argument: `/proc` shows a
 * process's arguments to every user on the machine, its variables only
 * to its own. Both places that run a fence's text are held to it.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outside } from "../../../../lib/internal/fence/fence-preflight.ts";

const STAND_IN = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"scripts",
	"fixtures",
	"fence-child.mts",
);

/** Stands in for a token; only the text names it. */
const MARK = "eyJtark.eyJtark.c2lnbmF0dXJl";

/**
 * Text that prints its own bash's arguments, then whether the variable
 * that carried it is still set when the command runs.
 */
const TEXT = [
	`: ${MARK}`,
	// On one line, since pi-fence's watcher, before the text, spans several.
	`tr '\\0\\n' '  ' </proc/$$/cmdline`,
	"echo",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
	'echo "carried: ${PI_FENCE_TEXT:-unset}"',
].join("\n");

let folder = "";

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "fence-text-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** What pi-fence's child prints running `text`, as pi-fence runs it. */
function throughTheChild(text: string): Promise<string> {
	return new Promise((done, failed) => {
		const ran = spawn(
			process.execPath,
			["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", STAND_IN, text],
			{ cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		ran.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		ran.on("error", failed);
		ran.on("close", () => done(out));
	});
}

describe("a fence's text", () => {
	it("reaches pi-fence's shell in a variable, unset before it runs, and on no argument", async () => {
		const said = await throughTheChild(TEXT);
		const [argv = "", carried = ""] = said.trim().split("\n");
		expect(argv).toContain("bash -c");
		expect(argv, "the text showed in bash's arguments").not.toContain(MARK);
		expect(carried).toBe("carried: unset");
	});

	it("reaches the pre-flight's shell in a variable, unset before it runs, and on no argument", async () => {
		const ran = await outside(TEXT, folder);
		expect(ran.code, ran.err).toBe(0);
		const [argv = "", carried = ""] = ran.out.trim().split("\n");
		expect(argv).toContain("bash -c");
		expect(argv, "the text showed in bash's arguments").not.toContain(MARK);
		expect(carried).toBe("carried: unset");
	});
});
