import { describe, expect, it } from "vitest";
import { kindOf, scriptWords } from "./script.ts";

describe("kindOf", () => {
	it("reads util-linux from its version line", () => {
		expect(
			kindOf({ stdout: "script from util-linux 2.42\n" }),
			"util-linux names itself for -V",
		).toBe("util-linux");
	});

	it("reads BSD from a run that printed no version", () => {
		expect(
			kindOf({ stdout: "" }),
			"BSD script refuses -V and prints its usage to stderr",
		).toBe("bsd");
		expect(kindOf({ stdout: null }), "no stdout at all reads as BSD too").toBe(
			"bsd",
		);
	});

	it("reads none when script could not start", () => {
		expect(
			kindOf({ error: new Error("spawnSync script ENOENT"), stdout: null }),
			"no script(1) on the PATH",
		).toBeUndefined();
	});
});

describe("scriptWords", () => {
	it("gives util-linux the command after -c, keeping no typescript", () => {
		expect(scriptWords("util-linux", "pi --x")).toEqual([
			"-qfec",
			"pi --x",
			"/dev/null",
		]);
	});

	it("gives BSD the file first and the command through sh", () => {
		expect(scriptWords("bsd", "pi --x")).toEqual([
			"-qeF",
			"/dev/null",
			"/bin/sh",
			"-c",
			"pi --x",
		]);
	});
});
