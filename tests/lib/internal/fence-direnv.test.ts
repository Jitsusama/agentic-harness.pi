/**
 * A fenced command's direnv trusts the work trees and the quests'
 * scratch folders, through settings of the fence's own, since the
 * person's allow list is read-only inside and a tree cut a minute ago
 * was never allowed (ISXEG8 [cb9b85fd], 15 November). The settings are
 * written from outside, so they sit where nothing inside can write, and
 * a link planted on the way is never followed (ISXEG8 [3fcd33a5]).
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";
import {
	DIRENV_ROUTE,
	fenceDirenv,
	personDirenvConfig,
	routedDirenv,
} from "../../../lib/internal/fence-direnv.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";

function folders(): { top: string; person: string; runtime: string } {
	const top = mkdtempSync(join(tmpdir(), "fence-direnv-"));
	const person = join(top, "config", "direnv");
	mkdirSync(join(person, "lib"), { recursive: true });
	writeFileSync(join(person, "lib", "nix-direnv.sh"), "use_flake() { :; }\n");
	const runtime = join(top, "run");
	mkdirSync(runtime);
	return { top, person, runtime };
}

/** Where the fence's settings land in the runtime folder `runtime`. */
const settingsIn = (runtime: string) => join(runtime, "pi-fence", "direnv");

/** A folder of the person's that a planted link would aim the write at. */
function decoy(top: string): string {
	const folder = join(top, "decoy");
	mkdirSync(join(folder, "keep"), { recursive: true });
	writeFileSync(join(folder, "keep", "theirs"), "theirs\n");
	writeFileSync(join(folder, "notes"), "theirs\n");
	return folder;
}

function untouched(folder: string): void {
	expect(readdirSync(folder).sort(), "the decoy's entries changed").toEqual([
		"keep",
		"notes",
	]);
	expect(readFileSync(join(folder, "keep", "theirs"), "utf8")).toBe("theirs\n");
}

const TRUSTED = ["/h/.local/state/pi/work/trees", "/h/.cache/pi/quests"];

describe("a fenced command's direnv", () => {
	it("keeps the person's library and trusts the trees and scratch folders", () => {
		const { person, runtime } = folders();
		const named = fenceDirenv(person, runtime, TRUSTED);
		expect(named, "no settings were made").toBe(settingsIn(runtime));
		expect(
			readlinkSync(join(settingsIn(runtime), "lib")),
			"the person's library isn't the one read",
		).toBe(join(person, "lib"));
		expect(readFileSync(join(settingsIn(runtime), "direnv.toml"), "utf8")).toBe(
			'[whitelist]\nprefix = ["/h/.local/state/pi/work/trees", "/h/.cache/pi/quests"]\n',
		);
	});

	it("is made again as it was, and drops what the person's settings no longer hold", () => {
		const { person, runtime } = folders();
		writeFileSync(join(person, "direnvrc"), "# theirs\n");
		fenceDirenv(person, runtime, TRUSTED);
		const again = fenceDirenv(person, runtime, TRUSTED);
		expect(again, "a second making failed").toBe(settingsIn(runtime));
		expect(readlinkSync(join(settingsIn(runtime), "direnvrc"))).toBe(
			join(person, "direnvrc"),
		);
		rmSync(join(person, "direnvrc"));
		fenceDirenv(person, runtime, TRUSTED);
		expect(
			existsSync(join(settingsIn(runtime), "direnvrc")),
			"a direnvrc the person dropped is still read",
		).toBe(false);
		expect(
			existsSync(join(settingsIn(runtime), "direnv.toml")),
			"the fence's own settings went too",
		).toBe(true);
	});

	it("follows no link planted for its folder or pi's, writing and removing nothing there", () => {
		for (const planted of ["direnv", "pi"] as const) {
			const { top, person, runtime } = folders();
			const aimed = decoy(top);
			if (planted === "pi") symlinkSync(aimed, join(runtime, "pi-fence"));
			else {
				mkdirSync(join(runtime, "pi-fence"));
				symlinkSync(aimed, settingsIn(runtime));
			}
			expect(
				fenceDirenv(person, runtime, TRUSTED),
				`a planted ${planted} link was followed`,
			).toBeUndefined();
			untouched(aimed);
		}
	});

	it("removes no folder found among its settings", () => {
		const { person, runtime } = folders();
		fenceDirenv(person, runtime, TRUSTED);
		rmSync(join(settingsIn(runtime), "lib"));
		const folder = join(settingsIn(runtime), "lib");
		mkdirSync(folder);
		writeFileSync(join(folder, "theirs"), "theirs\n");
		expect(
			fenceDirenv(person, runtime, TRUSTED),
			"a folder in a link's place was replaced",
		).toBeUndefined();
		expect(readFileSync(join(folder, "theirs"), "utf8")).toBe("theirs\n");
	});

	it("is made nowhere without a runtime folder", () => {
		const { person } = folders();
		expect(fenceDirenv(person, undefined, TRUSTED)).toBeUndefined();
	});

	it("is left as the person's when they keep settings of their own", () => {
		const { person, runtime } = folders();
		writeFileSync(
			join(person, "direnv.toml"),
			"[global]\nwarn_timeout = '1m'\n",
		);
		expect(
			fenceDirenv(person, runtime, TRUSTED),
			"the person's settings would have been replaced",
		).toBeUndefined();
	});

	it("is the person's own settings folder, where they name one", () => {
		expect(personDirenvConfig("/h", {})).toBe("/h/.config/direnv");
		expect(personDirenvConfig("/h", { XDG_CONFIG_HOME: "/x" })).toBe(
			"/x/direnv",
		);
		expect(personDirenvConfig("/h", { DIRENV_CONFIG: "/d" })).toBe("/d");
	});
});

describe("the fence's own direnv settings inside", () => {
	const disk: Disk = { kind: () => "folder", entries: () => [] };
	const place = { home: "/home/someone", runtimeDir: "/run/user/1000" };
	const direnv = "/run/user/1000/pi-fence/direnv";

	it("are bound read-only where they are, after the runtime folder is emptied", () => {
		const given = fenceArgs({ ...place, direnv }, disk);
		const at = given.indexOf(direnv);
		expect(given.slice(at - 1, at + 2), "not bound read-only").toEqual([
			"--ro-bind",
			direnv,
			direnv,
		]);
		expect(
			given.indexOf("/run/user/1000"),
			"the runtime folder is emptied after the bind, hiding it",
		).toBeLessThan(at);
		expect(
			given.filter((arg) => arg === direnv),
			"bound more than once, or writable",
		).toHaveLength(2);
	});

	it("are bound nowhere when none were made", () => {
		expect(fenceArgs(place, disk)).not.toContain(direnv);
	});
});

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("a fenced direnv refused an .envrc", () => {
	it("is told what runs without approval, and counted once", () => {
		let counted = 0;
		const said = [
			"direnv: error /h/elsewhere/.envrc is blocked. Run `direnv allow` to approve its content",
			"direnv: error open /h/.local/share/direnv/allow/641a1bac: read-only file system",
		];
		for (const one of said) {
			counted = 0;
			expect(
				routedDirenv(text(one), () => {
					counted += 1;
				}),
				one,
			).toEqual(text(`${one}\n\n${DIRENV_ROUTE}`));
			expect(counted, "it wasn't counted once").toBe(1);
		}
		for (const route of ["direnv exec", "work tree", "~/src"])
			expect(DIRENV_ROUTE, `the route doesn't name ${route}`).toContain(route);
	});

	it("leaves direnv that loaded as it is", () => {
		expect(
			routedDirenv(text("direnv: loading ~/src/core.nix/.envrc"), () => {}),
		).toBeUndefined();
	});
});
