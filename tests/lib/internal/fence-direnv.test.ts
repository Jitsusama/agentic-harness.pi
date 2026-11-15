/**
 * A fenced command's direnv trusts the work trees and the quests'
 * scratch folders, through settings of the fence's own, since the
 * person's allow list is read-only inside and a tree cut a minute ago
 * was never allowed (ISXEG8 [cb9b85fd], 15 November).
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DIRENV_ROUTE,
	fenceDirenv,
	personDirenvConfig,
	routedDirenv,
} from "../../../lib/internal/fence-direnv.ts";

function folders(): { person: string; own: string } {
	const top = mkdtempSync(join(tmpdir(), "fence-direnv-"));
	const person = join(top, "config", "direnv");
	mkdirSync(join(person, "lib"), { recursive: true });
	writeFileSync(join(person, "lib", "nix-direnv.sh"), "use_flake() { :; }\n");
	return { person, own: join(top, "own") };
}

const TRUSTED = ["/h/.local/state/pi/work/trees", "/h/.cache/pi/quests"];

describe("a fenced command's direnv", () => {
	it("keeps the person's library and trusts the trees and scratch folders", () => {
		const { person, own } = folders();
		const named = fenceDirenv(person, own, TRUSTED);
		expect(named, "no settings were made").toEqual([
			"DIRENV_CONFIG",
			join(own, "direnv"),
		]);
		expect(
			readlinkSync(join(own, "direnv", "lib")),
			"the person's library isn't the one read",
		).toBe(join(person, "lib"));
		expect(readFileSync(join(own, "direnv", "direnv.toml"), "utf8")).toBe(
			'[whitelist]\nprefix = ["/h/.local/state/pi/work/trees", "/h/.cache/pi/quests"]\n',
		);
	});

	it("is made again as it was, and drops what the person's settings no longer hold", () => {
		const { person, own } = folders();
		writeFileSync(join(person, "direnvrc"), "# theirs\n");
		fenceDirenv(person, own, TRUSTED);
		const again = fenceDirenv(person, own, TRUSTED);
		expect(again, "a second making failed").toEqual([
			"DIRENV_CONFIG",
			join(own, "direnv"),
		]);
		expect(readlinkSync(join(own, "direnv", "direnvrc"))).toBe(
			join(person, "direnvrc"),
		);
		rmSync(join(person, "direnvrc"));
		fenceDirenv(person, own, TRUSTED);
		expect(
			existsSync(join(own, "direnv", "direnvrc")),
			"a direnvrc the person dropped is still read",
		).toBe(false);
		expect(
			existsSync(join(own, "direnv", "direnv.toml")),
			"the fence's own settings went too",
		).toBe(true);
	});

	it("is left as the person's when they keep settings of their own", () => {
		const { person, own } = folders();
		writeFileSync(
			join(person, "direnv.toml"),
			"[global]\nwarn_timeout = '1m'\n",
		);
		expect(
			fenceDirenv(person, own, TRUSTED),
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
