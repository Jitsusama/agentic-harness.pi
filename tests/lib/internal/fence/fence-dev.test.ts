/**
 * The session's own copies of dev's settings and git's global settings,
 * which a fenced `dev up` writes in place of the person's.
 */

import {
	chmodSync,
	existsSync,
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
	type DevMaker,
	fenceDevCopies,
	gitGlobalIn,
} from "../../../../lib/internal/fence/fence-dev.ts";

/** A pi process with the id `pid`, which sees running only the processes `running` names. */
function maker(pid: number, running: readonly number[] = []): DevMaker {
	return { made: new Map(), pid, alive: (other) => running.includes(other) };
}

describe("the session's copies of dev's and git's settings", () => {
	let base: string;
	let home: string;
	let runtime: string;
	let sessions: string;

	/** The pi making copies, so each case starts as a new pi. */
	let pi: DevMaker;
	const copiesOf = (
		session: string | undefined,
		env: { XDG_RUNTIME_DIR?: string; XDG_CONFIG_HOME?: string } = {
			XDG_RUNTIME_DIR: runtime,
		},
	) => fenceDevCopies(home, env, session, pi);

	beforeEach(() => {
		pi = maker(100);
		base = mkdtempSync(join(tmpdir(), "fd-"));
		home = join(base, "home");
		runtime = join(base, "run");
		sessions = join(runtime, "pi-fence", "dev");
		mkdirSync(join(home, ".config", "dev"), { recursive: true });
		mkdirSync(runtime);
		writeFileSync(join(home, ".config", "dev", "gitconfig"), "[credential]\n");
		writeFileSync(join(base, "elsewhere"), "[user]\n");
		symlinkSync(
			join(base, "elsewhere"),
			join(home, ".config", "dev", "gitconfig.identity"),
		);
		writeFileSync(join(home, ".gitconfig"), "[core]\n\teditor = vi\n");
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("copies both into a folder for the session and this pi in pi's runtime folder, for the person alone", () => {
		const copies = copiesOf("s-1");
		const folder = join(sessions, "s-1.100");
		expect(copies).toEqual({
			dev: join(folder, "dev"),
			git: join(folder, "git"),
		});
		expect(readFileSync(join(folder, "dev", "gitconfig"), "utf8")).toBe(
			"[credential]\n",
		);
		expect(readFileSync(gitGlobalIn(join(folder, "git")), "utf8")).toBe(
			"[core]\n\teditor = vi\n",
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
		expect(statSync(gitGlobalIn(join(folder, "git"))).mode & 0o777).toBe(0o600);
	});

	it("keeps a session's copies for this pi's later commands, and makes the next pi's afresh beside them", () => {
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		writeFileSync(join(copies.dev, "gitconfig"), "[credential] written\n");
		writeFileSync(gitGlobalIn(copies.git), "[core] written\n");
		expect(
			readFileSync(join(home, ".config", "dev", "gitconfig"), "utf8"),
		).toBe("[credential]\n");
		expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(
			"[core]\n\teditor = vi\n",
		);
		expect(copiesOf("s-1"), "a later command finds the same copies").toEqual(
			copies,
		);
		expect(
			readFileSync(join(copies.dev, "gitconfig"), "utf8"),
			"a command still running holds them, so they're left as it wrote them",
		).toBe("[credential] written\n");

		pi = maker(200, [100]);
		const next = copiesOf("s-1");
		if (!next) throw new Error("no copies were made");
		expect(next.dev).toBe(join(sessions, "s-1.200", "dev"));
		expect(
			readFileSync(join(next.dev, "gitconfig"), "utf8"),
			"the next pi starts from the person's files",
		).toBe("[credential]\n");
		expect(
			readFileSync(join(copies.dev, "gitconfig"), "utf8"),
			"another pi on the same session never touches a running pi's copies",
		).toBe("[credential] written\n");
	});

	it("removes the copies of a pi that has ended, and nothing else there", () => {
		copiesOf("s-1");
		pi = maker(200, [300]);
		mkdirSync(join(sessions, "s-2.300"));
		mkdirSync(join(sessions, "kept"));
		copiesOf("s-1");
		expect(existsSync(join(sessions, "s-1.100")), "the ended pi's").toBe(false);
		expect(existsSync(join(sessions, "s-2.300")), "a running pi's").toBe(true);
		expect(existsSync(join(sessions, "kept")), "one no pi named").toBe(true);
	});

	it("removes an ended pi's link as a link, leaving what it leads to alone", () => {
		const victim = join(base, "victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "kept"), "kept\n");
		mkdirSync(sessions, { recursive: true });
		symlinkSync(victim, join(sessions, "s-2.300"));
		expect(copiesOf("s-1")).toBeDefined();
		expect(existsSync(join(sessions, "s-2.300"))).toBe(false);
		expect(readFileSync(join(victim, "kept"), "utf8")).toBe("kept\n");
	});

	it("includes git's XDG settings ahead of the global file's, as git reads both", () => {
		mkdirSync(join(home, ".config", "git"));
		writeFileSync(join(home, ".config", "git", "config"), "[user]\n");
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe(
			`[include]\n\tpath = "${join(home, ".config", "git", "config")}"\n[core]\n\teditor = vi\n`,
		);

		const moved = join(base, "settings");
		mkdirSync(join(moved, "git"), { recursive: true });
		writeFileSync(join(moved, "git", "config"), "[user]\n");
		pi = maker(200);
		const elsewhere = copiesOf("s-1", {
			XDG_RUNTIME_DIR: runtime,
			XDG_CONFIG_HOME: moved,
		});
		if (!elsewhere) throw new Error("no copies were made");
		expect(
			readFileSync(gitGlobalIn(elsewhere.git), "utf8"),
			"the XDG folder the environment names",
		).toContain(`path = "${join(moved, "git", "config")}"`);
	});

	it("names an include's relative path from the home folder, where git found it, and leaves the rest", () => {
		writeFileSync(
			join(home, ".gitconfig"),
			[
				"[include]",
				"\tpath = extra.inc",
				'\tpath = "quoted.inc"',
				"\tpath = /abs.inc",
				"\tpath = ~/tilde.inc",
				'[includeIf "gitdir:~/work/"]',
				"\tpath = work.inc",
				"[core]",
				"\tpath = not-an-include",
				"",
			].join("\n"),
		);
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe(
			[
				"[include]",
				`\tpath = "${join(home, "extra.inc")}"`,
				`\tpath = "${join(home, "quoted.inc")}"`,
				"\tpath = /abs.inc",
				"\tpath = ~/tilde.inc",
				'[includeIf "gitdir:~/work/"]',
				`\tpath = "${join(home, "work.inc")}"`,
				"[core]",
				"\tpath = not-an-include",
				"",
			].join("\n"),
		);
	});

	it("makes an empty global settings file where the person has none", () => {
		rmSync(join(home, ".gitconfig"));
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe("");
	});

	it("is nothing without a runtime folder, dev's settings or a session whose id names one folder", () => {
		expect(copiesOf("s-1", {})).toBeUndefined();
		expect(copiesOf(undefined)).toBeUndefined();
		expect(copiesOf("../s-1")).toBeUndefined();
		expect(copiesOf("s.1"), "an id that reads as a pi's").toBeUndefined();
		rmSync(join(home, ".config", "dev"), { recursive: true });
		expect(copiesOf("s-1")).toBeUndefined();
	});

	it("follows no link at any of pi's folders, and leaves what it leads to alone", () => {
		const victim = join(base, "victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "kept"), "kept\n");
		for (const at of [
			join(runtime, "pi-fence"),
			sessions,
			join(sessions, "s-1.100"),
		]) {
			rmSync(join(runtime, "pi-fence"), { recursive: true, force: true });
			mkdirSync(join(at, ".."), { recursive: true });
			symlinkSync(victim, at);
			pi = maker(100);
			expect(copiesOf("s-1"), at).toBeUndefined();
			expect(readFileSync(join(victim, "kept"), "utf8")).toBe("kept\n");
			expect(existsSync(join(victim, "dev")), at).toBe(false);
		}
	});

	it("tries no more once the copies couldn't be made, so each command runs as before", () => {
		mkdirSync(join(runtime, "pi-fence"), { mode: 0o500 });
		expect(copiesOf("s-1")).toBeUndefined();
		chmodSync(join(runtime, "pi-fence"), 0o700);
		expect(
			copiesOf("s-1"),
			"a later command in the same pi tried again",
		).toBeUndefined();
		pi = maker(200);
		expect(copiesOf("s-1"), "the next pi tries afresh").toBeDefined();
	});
});
