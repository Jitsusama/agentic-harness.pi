/**
 * The session's own copies of dev's settings and git's global settings,
 * which a fenced `dev up` writes in place of the person's.
 */

import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DevCopies,
	fenceDevCopies,
	gitGlobalIn,
} from "../../../../lib/internal/fence/fence-dev.ts";

describe("the session's copies of dev's and git's settings", () => {
	let base: string;
	let home: string;
	let runtime: string;

	/** What one pi has made, so each case starts as a new pi. */
	let made: Map<string, DevCopies>;
	const copiesOf = (session: string | undefined, runtimeDir = runtime) =>
		fenceDevCopies(home, runtimeDir, session, made);

	beforeEach(() => {
		made = new Map();
		base = mkdtempSync(join(tmpdir(), "fd-"));
		home = join(base, "home");
		runtime = join(base, "run");
		mkdirSync(join(home, ".config", "dev"), { recursive: true });
		mkdirSync(runtime);
		writeFileSync(join(home, ".config", "dev", "gitconfig"), "[credential]\n");
		writeFileSync(join(base, "elsewhere"), "[user]\n");
		symlinkSync(
			join(base, "elsewhere"),
			join(home, ".config", "dev", "gitconfig.identity"),
		);
		writeFileSync(join(home, ".gitconfig"), "[include]\n");
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("copies both into the session's folder in pi's runtime folder, for the person alone", () => {
		const copies = copiesOf("s-1");
		const folder = join(runtime, "pi-fence", "dev", "s-1");
		expect(copies).toEqual({
			dev: join(folder, "dev"),
			git: join(folder, "git"),
		});
		expect(readFileSync(join(folder, "dev", "gitconfig"), "utf8")).toBe(
			"[credential]\n",
		);
		expect(readFileSync(gitGlobalIn(join(folder, "git")), "utf8")).toBe(
			"[include]\n",
		);
		expect(
			lstatSync(join(folder, "dev", "gitconfig.identity")).isSymbolicLink(),
			"a link stays one, so what it leads to is seen only as the fence shows it",
		).toBe(true);
		expect(
			readFileSync(join(folder, "dev", "gitconfig.identity"), "utf8"),
		).toBe("[user]\n");
		for (const made of [folder, join(folder, "dev"), join(folder, "git")])
			expect(statSync(made).mode & 0o777, made).toBe(0o700);
	});

	it("keeps a session's copies for this pi's later commands, and makes the next pi's afresh", () => {
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		writeFileSync(join(copies.dev, "gitconfig"), "[credential] written\n");
		writeFileSync(gitGlobalIn(copies.git), "[core] written\n");
		expect(
			readFileSync(join(home, ".config", "dev", "gitconfig"), "utf8"),
		).toBe("[credential]\n");
		expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe("[include]\n");
		expect(copiesOf("s-1"), "a later command finds the same copies").toEqual(
			copies,
		);
		expect(
			readFileSync(join(copies.dev, "gitconfig"), "utf8"),
			"a command still running holds them, so they're left as it wrote them",
		).toBe("[credential] written\n");
		made = new Map();
		expect(copiesOf("s-1")).toEqual(copies);
		expect(
			readFileSync(join(copies.dev, "gitconfig"), "utf8"),
			"the next pi starts from the person's files",
		).toBe("[credential]\n");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe("[include]\n");
	});

	it("makes an empty global settings file where the person has none", () => {
		rmSync(join(home, ".gitconfig"));
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe("");
	});

	it("is nothing without a runtime folder, dev's settings or a session whose id names one folder", () => {
		expect(fenceDevCopies(home, undefined, "s-1", made)).toBeUndefined();
		expect(copiesOf(undefined)).toBeUndefined();
		expect(copiesOf("../s-1")).toBeUndefined();
		rmSync(join(home, ".config", "dev"), { recursive: true });
		expect(copiesOf("s-1")).toBeUndefined();
	});

	it("follows no link where a copy goes, and leaves what it leads to alone", () => {
		const victim = join(base, "victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "kept"), "kept\n");
		mkdirSync(join(runtime, "pi-fence", "dev"), { recursive: true });
		symlinkSync(victim, join(runtime, "pi-fence", "dev", "s-1"));
		expect(copiesOf("s-1")).toBeUndefined();
		expect(readFileSync(join(victim, "kept"), "utf8")).toBe("kept\n");
	});
});
