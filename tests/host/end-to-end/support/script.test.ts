import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindOf, scriptLaunch, scriptWords } from "./script.ts";

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

describe("scriptLaunch", () => {
	it("starts util-linux's script as it is", () => {
		expect(scriptLaunch("util-linux", "pi --x")).toEqual({
			file: "script",
			args: scriptWords("util-linux", "pi --x"),
		});
	});

	it("starts BSD's script as its own pid, with a pipe rather than node's socket on its stdin, and hands it what is typed", async () => {
		// A stand-in script(1), since only a Mac has BSD's: it says what its
		// stdin is, its pid and its arguments, then echoes one typed line.
		const bin = mkdtempSync(join(tmpdir(), "bsd-script-"));
		try {
			const stand = join(bin, "script");
			writeFileSync(
				stand,
				[
					"#!/bin/sh",
					'if [ -p /dev/stdin ]; then echo "stdin pipe"; else echo "stdin other"; fi',
					'echo "pid $$"',
					'echo "args $*"',
					"read -r line",
					'echo "typed $line"',
				].join("\n"),
			);
			chmodSync(stand, 0o755);
			const { file, args } = scriptLaunch("bsd", "pi --x");
			const child = spawn(file, args, {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString("utf8");
			});
			const exited = once(child, "exit");
			child.stdin.write("hello\n");
			child.stdin.end();
			const [code] = await exited;
			expect(code, `the stand-in ended well; it wrote:\n${out}`).toBe(0);
			expect(out.split("\n").filter(Boolean)).toEqual([
				"stdin pipe",
				`pid ${child.pid}`,
				"args -qeF /dev/null /bin/sh -c pi --x",
				"typed hello",
			]);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("starts BSD's script with no child of its own while node still holds its stdin open", async () => {
		// F1 on #2385: the pipe's cat, forked before the exec, stayed
		// script's child, and a Mac's pgrep -P named it before the command,
		// so the terminal's pi was taken to be cat. The stand-in starts
		// nothing, so any child it has came from the launch.
		const bin = mkdtempSync(join(tmpdir(), "bsd-script-"));
		try {
			const stand = join(bin, "script");
			writeFileSync(
				stand,
				[
					"#!/bin/sh",
					'echo "started"',
					"read -r line",
					'echo "typed $line"',
				].join("\n"),
			);
			chmodSync(stand, 0o755);
			const { file, args } = scriptLaunch("bsd", "pi --x");
			const child = spawn(file, args, {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const exited = once(child, "exit");
			const [chunk] = await once(child.stdout, "data");
			expect(String(chunk), "the stand-in started").toBe("started\n");
			const children = spawnSync("pgrep", ["-P", String(child.pid)], {
				encoding: "utf8",
			}).stdout;
			child.stdin.write("hello\n");
			child.stdin.end();
			const [code] = await exited;
			expect(children, "script's children with its stdin still open").toBe("");
			expect(code, "the stand-in still took what was typed").toBe(0);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});
});
