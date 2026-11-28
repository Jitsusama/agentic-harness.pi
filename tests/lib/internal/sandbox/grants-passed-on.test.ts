/**
 * A machine's grants reach what strict runs and what pi's file tools may
 * touch, read for the session's own place: the home the fence lays for
 * it, its runtime folder and the node's worker socket it lets through.
 * Every case hands in its own reader, so none reads this machine's
 * `/etc/pi-sandbox/strict-grants.json` or the person's settings.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	GrantPlace,
	GrantsReader,
	MachineGrants,
} from "../../../../lib/internal/sandbox/machine-grants.ts";
import {
	type Sandbox,
	wrapFor,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import { fileToolRefusal } from "../../../../lib/internal/sandbox/sandbox-files.ts";

let base: string;
let home: string;
let work: string;
let granted: MachineGrants;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "grants-passed-")));
	home = join(base, "home");
	work = join(base, "work");
	granted = { read: [join(base, "read")], write: [join(base, "write")] };
	for (const folder of [home, work, ...granted.read, ...granted.write]) {
		mkdirSync(folder, { recursive: true });
	}
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A reader granting `grants`, keeping each place it was asked for. */
function reading(grants: () => MachineGrants): GrantsReader & {
	asked: GrantPlace[];
} {
	const asked: GrantPlace[] = [];
	return Object.assign(
		(place: GrantPlace) => {
			asked.push(place);
			return grants();
		},
		{ asked },
	);
}

/** The strict sandbox, its grants read by `grants`. */
function strict(grants: GrantsReader, served = false): Sandbox {
	return {
		kind: "strict",
		landrun: "/bin/landrun",
		grants,
		...(served ? { served } : {}),
	};
}

/** The text a strict command runs as, in the work. */
function wrapped(sandbox: Sandbox, env: NodeJS.ProcessEnv = {}): string {
	const wrap = wrapFor(
		sandbox,
		{ cwd: work, env: { PATH: "/bin", ...env } },
		home,
	);
	if (!wrap) throw new Error("no wrap for a strict sandbox");
	return wrap("true");
}

describe("a strict command's grants", () => {
	it("are read for the session's home and runtime folder", () => {
		const grants = reading(() => granted);
		wrapped(strict(grants), { XDG_RUNTIME_DIR: join(base, "run") });
		expect(grants.asked, "asked once, for the session's place").toEqual([
			{ home, runtimeDir: join(base, "run") },
		]);
	});

	it("reach landrun, read-only for a read and buildable for a write", () => {
		const text = wrapped(strict(reading(() => granted)));
		expect(text, "the read").toContain(`--ro '${granted.read[0]}'`);
		expect(text, "the write").toContain(`--rwx '${granted.write[0]}'`);
	});

	it("are none for a served command, its reader never asked", () => {
		const grants = reading(() => granted);
		const text = wrapped(strict(grants, true));
		expect(grants.asked, "never asked").toEqual([]);
		expect(text, "no read granted").not.toContain(granted.read[0]);
		expect(text, "no write granted").not.toContain(granted.write[0]);
	});
});

describe("pi's file tools under the machine's grants", () => {
	const env = { PI_SANDBOX: "strict" };
	const asking = (
		toolName: string,
		path: string,
		grants: GrantsReader,
		served = false,
	) =>
		fileToolRefusal(
			{ toolName, input: { path, content: "x" } },
			{ cwd: work, env, home, grants, ...(served ? { served } : {}) },
		);

	it("read and write what the machine grants, judged for the session's home", () => {
		const grants = reading(() => granted);
		const read = join(granted.read[0] ?? "", "notes.md");
		const written = join(granted.write[0] ?? "", "notes.md");
		expect(asking("read", read, grants), "the read").toBeUndefined();
		expect(asking("write", written, grants), "the write").toBeUndefined();
		expect(
			grants.asked.map((place) => place.home),
			"each judged for the session's home",
		).toEqual([home, home]);
	});

	it("never write what the machine grants only to read", () => {
		const read = join(granted.read[0] ?? "", "notes.md");
		expect(
			asking(
				"write",
				read,
				reading(() => granted),
			),
			"refused",
		).toContain("didn't run");
	});

	it("take none for a served session, its reader never asked", () => {
		const grants = reading(() => granted);
		const read = join(granted.read[0] ?? "", "notes.md");
		expect(asking("read", read, grants, true), "refused").toContain(
			"didn't run",
		);
		expect(grants.asked, "never asked").toEqual([]);
	});
});
