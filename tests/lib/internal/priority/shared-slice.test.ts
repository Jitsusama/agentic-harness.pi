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
import { inSharedSlice } from "../../../../lib/internal/priority/shared-slice.ts";

let root: string;
let bin: string;

// The test's own shell may run in the slice already.
const withoutSlice = { ...process.env };
delete withoutSlice.SHARED_SLICE;

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
	// systemd-run as it runs a scope: what it was asked, then the command.
	const standIn = join(bin, "systemd-run");
	writeFileSync(
		standIn,
		`#!/usr/bin/env bash\nprintf '%s\\n' "$@" | head -6 > '${join(root, "asked")}'\nwhile [ "$1" != -- ]; do shift; done; shift\nexec "$@"\n`,
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
			"--",
		]);
	});

	it("runs as it was where SHARED_SLICE is unset", () => {
		const ran = run(inSharedSlice(COMMAND), {});
		expect(ran.status).toBe(3);
		expect(said("out")).toEqual(["it's kept"]);
		expect(said("asked")).toEqual([]);
	});

	it("runs as it was where there is no systemd of the person's to ask", () => {
		const ran = run(inSharedSlice(COMMAND), {
			SHARED_SLICE: "shared.slice",
			XDG_RUNTIME_DIR: "",
		});
		expect(ran.status).toBe(3);
		expect(said("out")).toEqual(["it's kept"]);
		expect(said("asked")).toEqual([]);
	});
});
