import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	inSharedSlice,
	SLICE_GIVEN_UP,
} from "../../../../lib/internal/priority/shared-slice.ts";

let root: string;
let bin: string;

// The test's own shell may run in the slice already.
const withoutSlice = { ...process.env };
delete withoutSlice.SHARED_SLICE;

// What the slice's form may take with the queue's lines: Linux's one
// string, less the room kept for what goes around it after the queue.
const ROOM = 128 * 1024 - 4 * 1024;

// A command whose quotes, variable and exit status must all come through.
const COMMAND = `x='it'"'"'s'; echo "$x $HOME_TOO" >> "$OUT"; exit 3`;

/**
 * Runs `lines` in bash with the stand-in first on PATH, as `env` says.
 * The rest of the environment comes along, since NixOS's bash rebuilds
 * PATH for a shell given none of it.
 */
const run = (lines: string, env: Record<string, string>) =>
	spawnSync("bash", ["-c", lines], {
		encoding: "utf8",
		env: {
			...withoutSlice,
			XDG_RUNTIME_DIR: root,
			PATH: `${bin}:${process.env.PATH}`,
			OUT: join(root, "out"),
			HOME_TOO: "kept",
			...env,
		},
	});

const said = (name: string) => {
	try {
		return readFileSync(join(root, name), "utf8").trim().split("\n");
	} catch {
		return [];
	}
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shared-slice-"));
	bin = join(root, "bin");
	mkdirSync(bin);
	// systemd-run as it runs a scope: what it was asked, then the command,
	// each ${...} in it expanded first, as systemd-run does unless told
	// --expand-environment=no; a name it can't read, such as an array's,
	// fails the run before the command starts, as systemd 262 does.
	const standIn = join(bin, "systemd-run");
	writeFileSync(
		standIn,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$@" | head -7 > '${join(root, "asked")}'`,
			"expand=yes",
			'while [ "$1" != -- ]; do [ "$1" = --expand-environment=no ] && expand=no; shift; done; shift',
			`if [ $expand = yes ] && printf '%s' "$*" | grep -q '\\\${[^}]*\\['; then echo 'Invalid environment variable name evaluates to an empty string' >&2; exit 1; fi`,
			'exec "$@"',
			"",
		].join("\n"),
	);
	chmodSync(standIn, 0o755);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("a command run in the shared slice", () => {
	it("runs as a scope of the slice SHARED_SLICE names, whole and with its status", () => {
		const ran = run(inSharedSlice(COMMAND), { SHARED_SLICE: "shared.slice" });
		expect({ status: ran.status, stderr: ran.stderr }).toEqual({
			status: 3,
			stderr: "",
		});
		expect(said("out")).toEqual(["it's kept"]);
		expect(said("asked")).toEqual([
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			"--slice=shared.slice",
			"--expand-environment=no",
			"--",
		]);
	});

	// ISXEG8 [e38b55c4], 15 November: a fenced fetch of World's main lost
	// the fence's "${__pi_env[@]}" to systemd-run, and never ran.
	it("keeps each braced variable for the command's own shell to expand", () => {
		const command = `a=(one two); echo "\${a[@]} \${HOME_TOO}" >> "$OUT"`;
		const ran = run(inSharedSlice(command), { SHARED_SLICE: "shared.slice" });
		expect({ status: ran.status, stderr: ran.stderr }).toEqual({
			status: 0,
			stderr: "",
		});
		expect(said("out")).toEqual(["one two kept"]);
	});

	it("runs as it was where neither the session nor the system names a slice", () => {
		const ran = run(inSharedSlice(COMMAND, join(root, "none")), {});
		expect(ran.status).toBe(3);
		expect(said("out")).toEqual(["it's kept"]);
		expect(said("asked")).toEqual([]);
	});

	it("takes the slice from the system's environment when the session started before it", () => {
		const system = join(root, "set-environment");
		writeFileSync(
			system,
			'export SHARED_SLICE="shared.slice"\nexport HOME_TOO="overwritten"\n',
		);
		const ran = run(inSharedSlice(COMMAND, system), {});
		expect(ran.status).toBe(3);
		expect(said("out")).toEqual(["it's kept"]);
		expect(said("asked")).toContain("--slice=shared.slice");
	});

	it("runs as it was, and says so, when its quotes, each quoted, take the slice's form past what Linux takes in one string", () => {
		// 26 KiB of empty quotes: twice over it is far short of the bound,
		// but each quote takes four bytes once quoted.
		const quotes = "'".repeat(26 * 1024);
		const quoted = `: ${quotes}\n${COMMAND}`;
		const plain = `: ${"x".repeat(quotes.length)}\n${COMMAND}`;
		const none = join(root, "none");
		expect(
			inSharedSlice(plain, none),
			"as long a command with no quotes keeps the slice",
		).toContain("systemd-run");

		const wrapped = inSharedSlice(quoted, none);

		expect(wrapped, "no slice asked for").not.toContain("systemd-run");
		const ran = run(wrapped, { SHARED_SLICE: "shared.slice" });
		expect(ran.status, "the command's own status").toBe(3);
		expect(said("out"), "the command ran").toEqual(["it's kept"]);
		expect(said("asked"), "nothing ran in a scope").toEqual([]);
		expect(ran.stderr, "the walk says where it runs").toContain(SLICE_GIVEN_UP);
	});

	it("says nothing of the slice it gave up where none is named", () => {
		const quoted = `: ${"'".repeat(26 * 1024)}\n${COMMAND}`;

		const ran = run(inSharedSlice(quoted, join(root, "none")), {});

		expect(ran.status, "the command's own status").toBe(3);
		expect(said("out"), "the command ran").toEqual(["it's kept"]);
		expect(ran.stderr, "nothing said of a slice there is none of").toBe("");
	});

	it("counts the queue's lines that go before it, to the byte", () => {
		const none = join(root, "none");
		const form = inSharedSlice(COMMAND, none);
		const left = ROOM - Buffer.byteLength(form);

		expect(inSharedSlice(COMMAND, none, left), "exactly room").toBe(form);
		expect(
			inSharedSlice(COMMAND, none, left + 1),
			"a byte short of room",
		).not.toContain("systemd-run");
	});

	it("runs as it was where there is no systemd of the person's to ask", () => {
		const ran = run(inSharedSlice(COMMAND, join(root, "none")), {
			SHARED_SLICE: "shared.slice",
			XDG_RUNTIME_DIR: "",
		});
		expect(ran.status).toBe(3);
		expect(said("out")).toEqual(["it's kept"]);
		expect(said("asked")).toEqual([]);
	});
});
