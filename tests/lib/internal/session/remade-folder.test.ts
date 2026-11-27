/**
 * A window's folder made again: the folder at PWD's path is what comes
 * next starts in, only when the one this process runs in is gone and a
 * folder stands at that path again.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	remadeFolder,
	startingIn,
} from "../../../../lib/internal/session/remade-folder.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "remade-folder-"));
	made.push(dir);
	return dir;
}

/** A process's folder, gone as node says it is. */
function gone(): string {
	throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" });
}

describe("remadeFolder", () => {
	it("names nothing while this process's folder stands", () => {
		expect(remadeFolder({ PWD: folder() }, () => "/here")).toBeUndefined();
	});

	it("names PWD's folder once this process's folder is gone and one stands there again", () => {
		const at = folder();
		expect(remadeFolder({ PWD: at }, gone)).toBe(at);
	});

	it("names nothing when nothing stands at PWD's path either", () => {
		expect(
			remadeFolder({ PWD: join(folder(), "removed") }, gone),
		).toBeUndefined();
	});

	it("names nothing when PWD's path is a file", () => {
		const file = join(folder(), "file");
		writeFileSync(file, "");
		expect(remadeFolder({ PWD: file }, gone)).toBeUndefined();
	});

	it("names nothing without an absolute PWD", () => {
		expect(remadeFolder({}, gone)).toBeUndefined();
		expect(remadeFolder({ PWD: "tree" }, gone)).toBeUndefined();
	});

	it("names nothing when the folder can't be read for another reason", () => {
		const denied = () => {
			throw Object.assign(new Error("uv_cwd"), { code: "EACCES" });
		};
		expect(remadeFolder({ PWD: folder() }, denied)).toBeUndefined();
	});
});

describe("startingIn", () => {
	it("enters the folder by its path and becomes the program", () => {
		expect(startingIn("/tree", ["pi", "--session", "log"])).toEqual([
			"sh",
			"-c",
			'cd -- "$1" || exit; shift; exec "$@"',
			"sh",
			"/tree",
			"pi",
			"--session",
			"log",
		]);
	});
});
