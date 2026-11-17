/**
 * The file a tool's answer names as its whole saved output is scrubbed as
 * the call's input says: a printing of the environment has every value
 * scrubbed, the same file named twice is scrubbed once, and a staging
 * file already at its name is never written through.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	scrubOutputFile,
	scrubSavedOutput,
} from "../../../../lib/internal/secrets/saved-output.ts";

const KEY = `AKIA${"QQQQWWWWEEEERRRR"}`;

let folder: string;
let file: string;

beforeEach(() => {
	folder = fs.mkdtempSync(path.join(os.tmpdir(), "saved-output-"));
	file = path.join(folder, `pi-bash-${randomBytes(8).toString("hex")}.log`);
});

afterEach(() => {
	fs.rmSync(folder, { recursive: true, force: true });
});

describe("a tool's saved output", () => {
	it("has a printed environment's every value scrubbed, read by the call's input", () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		fs.writeFileSync(file, `OP_SESSION_ab12=${value}\nHOME=/h\n`);
		const kinds = scrubSavedOutput(
			{ details: { fullOutputPath: file } },
			{ command: "printenv" },
			folder,
		);
		expect(fs.readFileSync(file, "utf8")).toBe(
			"OP_SESSION_ab12=[secret scrubbed: OP_SESSION_ab12]\nHOME=/h\n",
		);
		expect(kinds).toEqual(["OP_SESSION_ab12"]);
	});

	it("leaves the same value alone when the command prints no environment", () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		fs.writeFileSync(file, `OP_SESSION_ab12=${value}\n`);
		scrubSavedOutput(
			{ details: { fullOutputPath: file } },
			{ command: "cat notes.txt" },
			folder,
		);
		expect(fs.readFileSync(file, "utf8")).toContain(value);
	});

	it("scrubs a file named by both the details and the structured answer once", () => {
		fs.writeFileSync(file, `key ${KEY}\n`);
		const kinds = scrubSavedOutput(
			{
				details: { fullOutputPath: file },
				structuredContent: { fullOutputPath: file },
			},
			{ command: "make" },
			folder,
		);
		expect(kinds).toEqual(["AWS access key"]);
		expect(fs.readFileSync(file, "utf8")).toBe(
			"key [secret scrubbed: AWS access key]\n",
		);
	});

	it("never writes through a file or link already at the staging name", () => {
		const elsewhere = path.join(folder, "elsewhere.txt");
		fs.writeFileSync(elsewhere, "untouched");
		fs.writeFileSync(file, `key ${KEY}\n`);
		fs.symlinkSync(elsewhere, `${file}.scrubbing`);
		scrubOutputFile(file);
		expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched");
		expect(fs.readFileSync(file, "utf8")).not.toContain(KEY);
	});
});
