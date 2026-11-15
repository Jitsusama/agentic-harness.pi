/**
 * Whether a side's pi can load every extension it was given: a link
 * whose target has gone is named, since pi skips it without a word.
 */
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingExtensions, missingFault } from "./extensions.ts";

const made: string[] = [];

/** An agent folder holding a linked extension, a gone one and a file. */
function agentFolder(): {
	readonly agentDir: string;
	readonly harness: string;
} {
	const root = mkdtempSync(join(tmpdir(), "soak-extensions-"));
	made.push(root);
	const harness = join(root, "harness");
	mkdirSync(join(harness, "kept-workflow"), { recursive: true });
	const agentDir = join(root, "agent");
	const extensions = join(agentDir, "extensions");
	mkdirSync(extensions, { recursive: true });
	symlinkSync(
		join(harness, "kept-workflow"),
		join(extensions, "kept-workflow"),
	);
	symlinkSync(join(harness, "gone-widget"), join(extensions, "gone-widget"));
	writeFileSync(join(extensions, "weigh.ts"), "export default () => {};\n");
	return { agentDir, harness };
}

afterEach(() => {
	for (const root of made.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("the extensions a side was given", () => {
	it("names each link whose target has gone, and no other", () => {
		const { agentDir } = agentFolder();
		expect(missingExtensions(agentDir)).toEqual(["gone-widget"]);
	});

	it("names every one once the harness itself has gone", () => {
		const { agentDir, harness } = agentFolder();
		rmSync(harness, { recursive: true });
		expect(missingExtensions(agentDir)).toEqual([
			"gone-widget",
			"kept-workflow",
		]);
	});

	it("finds none missing in a folder with no extensions", () => {
		const root = mkdtempSync(join(tmpdir(), "soak-extensions-"));
		made.push(root);
		expect(missingExtensions(root)).toEqual([]);
	});

	it("faults naming the folder when the extensions folder itself is gone", () => {
		const { agentDir } = agentFolder();
		rmSync(join(agentDir, "extensions"), { recursive: true });
		expect(missingFault("hosted", agentDir, "at its start")).toBe(
			`hosted had no extensions folder at its start: ${join(agentDir, "extensions")}`,
		);
	});

	it("says the fault by side and moment, or none when all are there", () => {
		const { agentDir, harness } = agentFolder();
		expect(missingFault("plain", agentDir, "at its start")).toBe(
			"plain lacked 1 extension at its start: gone-widget",
		);
		mkdirSync(join(harness, "gone-widget"));
		expect(missingFault("plain", agentDir, "at its start")).toBeUndefined();
	});
});
