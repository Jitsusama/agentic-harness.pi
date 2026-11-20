/**
 * The session's own copies of dev's settings and git's global settings,
 * which a fenced `dev up` writes in place of the person's.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
	running,
} from "../../../../lib/internal/fence/fence-dev.ts";

/** What each case's pi has said of copies it couldn't make. */
let told: string[] = [];

/**
 * A pi process with the id `pid`, which sees running only the processes
 * `running` names, in the pid namespace `ns`, hiding `hidden`, its
 * processes' mounts read as `mounts`, or unreadable where it's `null`.
 */
function maker(
	pid: number,
	running: readonly number[] = [],
	ns = "pid:[1]",
	hidden: readonly string[] = [],
	mounts: string | null = "",
): DevMaker {
	return {
		made: new Map(),
		pid,
		alive: (other) => running.includes(other),
		mounts: () => mounts ?? undefined,
		ns,
		hidden,
		tell: (why) => told.push(why),
	};
}

/** Whether this process is root, which no folder's mode stops. */
const root = process.getuid?.() === 0;

describe("the session's copies of dev's and git's settings", () => {
	let base: string;
	let home: string;
	let runtime: string;
	let sessions: string;

	/** The pi making copies, so each case starts as a new pi. */
	let pi: DevMaker;
	const copiesOf = (
		session: string | undefined,
		env: {
			XDG_RUNTIME_DIR?: string;
			XDG_CONFIG_HOME?: string;
			GIT_CONFIG_GLOBAL?: string;
		} = {
			XDG_RUNTIME_DIR: runtime,
		},
	) => fenceDevCopies(home, env, session, pi);

	beforeEach(() => {
		pi = maker(100);
		told = [];
		base = mkdtempSync(join(tmpdir(), "fd-"));
		home = join(base, "home");
		runtime = join(base, "run");
		sessions = join(runtime, "pi-fence", "dev");
		mkdirSync(join(home, ".config", "dev"), { recursive: true });
		mkdirSync(runtime, { mode: 0o700 });
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

	it("gives two conversations in one host, which share its pid, each only its own copies", () => {
		const first = copiesOf("s-1");
		const second = copiesOf("s-2");
		if (!first || !second) throw new Error("no copies were made");
		expect(second.dev).toBe(join(sessions, "s-2.100", "dev"));
		writeFileSync(join(first.dev, "gitconfig"), "[credential] first\n");
		expect(copiesOf("s-2"), "the second finds its own copies again").toEqual(
			second,
		);
		expect(readFileSync(join(second.dev, "gitconfig"), "utf8")).toBe(
			"[credential]\n",
		);
		expect(copiesOf("s-1"), "the first finds its own copies again").toEqual(
			first,
		);
		expect(readFileSync(join(first.dev, "gitconfig"), "utf8")).toBe(
			"[credential] first\n",
		);
	});

	it("makes a fresh set once the person's files change, leaving the set a running command holds", () => {
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		writeFileSync(join(copies.dev, "gitconfig"), "[credential] written\n");
		writeFileSync(join(home, ".gitconfig"), "[core]\n\teditor = nano\n");
		const after = copiesOf("s-1");
		if (!after) throw new Error("no copies were made");
		expect(after.git, "a set of its own").not.toBe(copies.git);
		expect(readFileSync(gitGlobalIn(after.git), "utf8")).toContain("nano");
		expect(
			readFileSync(join(copies.dev, "gitconfig"), "utf8"),
			"the set a command may still hold is left as it wrote it",
		).toBe("[credential] written\n");
		writeFileSync(join(home, ".config", "dev", "config"), "[dev]\n");
		const again = copiesOf("s-1");
		expect(again?.dev, "a new file in dev's folder").not.toBe(after.dev);
		expect(copiesOf("s-1"), "and kept while nothing changes").toEqual(again);

		pi = maker(200, [], "pid:[1]");
		copiesOf("s-1");
		expect(
			readdirSync(sessions).sort(),
			"every set of the ended pi goes",
		).toEqual(["s-1.200"]);
	});

	it("tells a fresh set's failure once for each change of the person's files, not at every command", () => {
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		chmodSync(runtime, 0o755);
		try {
			writeFileSync(join(home, ".gitconfig"), "[core]\n\teditor = nano\n");
			expect(copiesOf("s-1"), "the set before").toEqual(copies);
			expect(copiesOf("s-1"), "still the set before").toEqual(copies);
			expect(told, "told once for the one change").toHaveLength(1);
			writeFileSync(join(home, ".gitconfig"), "[core]\n\teditor = vi\n");
			copiesOf("s-1");
			expect(told, "told again once they change").toHaveLength(2);
		} finally {
			chmodSync(runtime, 0o700);
		}
	});

	it("makes the copies again where this pi's were removed, beside a folder under its id it doesn't know", () => {
		mkdirSync(join(sessions, "s-1.100", "held"), { recursive: true });
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(copies.dev).toBe(join(sessions, "s-1.100.1", "dev"));
		expect(
			existsSync(join(sessions, "s-1.100", "held")),
			"a set this pi made before a reload, which a command may hold, is left be",
		).toBe(true);
		rmSync(join(sessions, "s-1.100.1"), { recursive: true });
		expect(copiesOf("s-1")).toEqual(copies);
		expect(
			existsSync(join(copies.dev, "gitconfig")),
			"the set made again holds dev's gitconfig",
		).toBe(true);
	});

	it("leaves a reloaded pi's running command its set, making the next beside it", () => {
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		writeFileSync(join(copies.dev, "gitconfig"), "[credential] written\n");
		// The same pi, its module loaded afresh, knows nothing it made.
		pi = maker(100);
		const after = copiesOf("s-1");
		expect(after?.dev).toBe(join(sessions, "s-1.100.1", "dev"));
		expect(readFileSync(join(copies.dev, "gitconfig"), "utf8")).toBe(
			"[credential] written\n",
		);
	});

	it.skipIf(root)(
		"keeps the set it has where a fresh one can't be made, and tries again at the next command",
		() => {
			const copies = copiesOf("s-1");
			if (!copies) throw new Error("no copies were made");
			writeFileSync(join(home, ".gitconfig"), "[core]\n\teditor = nano\n");
			chmodSync(sessions, 0o500);
			try {
				expect(copiesOf("s-1"), "the working set was dropped").toEqual(copies);
				expect(told).toHaveLength(1);
			} finally {
				chmodSync(sessions, 0o700);
			}
			const after = copiesOf("s-1");
			expect(after?.git, "no fresh set once it could be made").not.toBe(
				copies.git,
			);
			if (!after) throw new Error("no copies were made");
			expect(readFileSync(gitGlobalIn(after.git), "utf8")).toContain("nano");
		},
	);

	it("leaves an ended pi's set while a command it left running has it mounted, or mounts can't be read", () => {
		copiesOf("s-1");
		const bound = `42 40 0:30 /${join("pi-fence", "dev", "s-1.100", "dev")} /home/p/.config/dev rw - tmpfs tmpfs rw\n`;
		pi = maker(200, [], "pid:[1]", [], bound);
		copiesOf("s-1");
		expect(existsSync(join(sessions, "s-1.100")), "a mounted set").toBe(true);
		pi = maker(300, [], "pid:[1]", [], null);
		copiesOf("s-1");
		expect(existsSync(join(sessions, "s-1.100")), "mounts unread").toBe(true);
		pi = maker(400);
		copiesOf("s-1");
		expect(readdirSync(sessions).sort(), "once none holds them").toEqual([
			"s-1.400",
		]);
	});

	it("copies no socket or pipe from dev's folder", () => {
		const pipe = join(home, ".config", "dev", "pipe");
		if (spawnSync("mkfifo", [pipe]).status !== 0)
			throw new Error("no mkfifo to make a pipe");
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(existsSync(join(copies.dev, "pipe")), "no pipe is copied").toBe(
			false,
		);
		expect(
			existsSync(join(copies.dev, "gitconfig")),
			"dev's gitconfig is copied",
		).toBe(true);
	});

	it("never removes copies made in another pid namespace, whose processes it can't see", () => {
		copiesOf("s-1");
		// A pi-fence inside a fence sees none of the processes outside it.
		pi = maker(7, [], "pid:[2]");
		copiesOf("s-1");
		expect(
			existsSync(join(sessions, "s-1.100", "git", "config")),
			"another namespace's copies are kept",
		).toBe(true);
	});

	it.skipIf(root)(
		"makes its copies though an ended pi's folder can't be removed",
		() => {
			mkdirSync(join(sessions, "s-2.300", "held"), { recursive: true });
			writeFileSync(join(sessions, "s-2.300", "held", "file"), "");
			writeFileSync(join(sessions, "s-2.300", "ns"), "pid:[1]");
			chmodSync(join(sessions, "s-2.300", "held"), 0o500);
			try {
				expect(copiesOf("s-1")).toBeDefined();
			} finally {
				chmodSync(join(sessions, "s-2.300", "held"), 0o700);
			}
		},
	);

	it("copies nothing the fence hides from dev's folder", () => {
		mkdirSync(join(home, ".config", "dev", "keys"));
		writeFileSync(join(home, ".config", "dev", "keys", "k"), "secret\n");
		writeFileSync(join(home, ".config", "dev", "token"), "secret\n");
		pi = maker(100, [], "pid:[1]", [".config/dev/keys/", ".config/dev/token"]);
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(
			existsSync(join(copies.dev, "keys")),
			"a hidden folder isn't copied",
		).toBe(false);
		expect(
			existsSync(join(copies.dev, "token")),
			"a hidden file isn't copied",
		).toBe(false);
		expect(
			existsSync(join(copies.dev, "gitconfig")),
			"dev's gitconfig is copied",
		).toBe(true);
	});

	it("makes none in a runtime folder others can reach, and says why", () => {
		chmodSync(runtime, 0o755);
		expect(copiesOf("s-1")).toBeUndefined();
		expect(told).toHaveLength(1);
		expect(told[0]).toContain(runtime);
	});

	it("tells a process that has ended from one still running", () => {
		expect(running(process.pid), "this process reads as running").toBe(true);
		const ended = spawnSync("true").pid;
		expect(running(ended), "an ended process reads as ended").toBe(false);
	});

	it("removes the copies of a pi that has ended, and nothing else there", () => {
		copiesOf("s-1");
		pi = maker(200, [300]);
		// Each names this pid namespace, so only the process or the name keeps it.
		for (const other of ["s-2.300", "kept"]) {
			mkdirSync(join(sessions, other));
			writeFileSync(join(sessions, other, "ns"), "pid:[1]");
		}
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
		expect(
			existsSync(join(sessions, "s-2.300")),
			"the ended pi's link is removed",
		).toBe(false);
		expect(readFileSync(join(victim, "kept"), "utf8")).toBe("kept\n");
	});

	it("writes git's XDG settings ahead of the global file's, as git reads both, since --global reads no include", () => {
		mkdirSync(join(home, ".config", "git"));
		writeFileSync(
			join(home, ".config", "git", "config"),
			"[user]\n\tname = p\n[include]\n\tpath = more.inc",
		);
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe(
			`[user]\n\tname = p\n[include]\n\tpath = "${join(home, ".config", "git", "more.inc")}"\n[core]\n\teditor = vi\n`,
		);

		const moved = join(base, "settings");
		mkdirSync(join(moved, "git"), { recursive: true });
		writeFileSync(join(moved, "git", "config"), "[include]\n\tpath = x.inc\n");
		pi = maker(200);
		const elsewhere = copiesOf("s-1", {
			XDG_RUNTIME_DIR: runtime,
			XDG_CONFIG_HOME: moved,
		});
		if (!elsewhere) throw new Error("no copies were made");
		expect(
			readFileSync(gitGlobalIn(elsewhere.git), "utf8"),
			"the XDG folder the environment names",
		).toContain(`path = "${join(moved, "git", "x.inc")}"`);
	});

	it("reads a global file written with CRLF endings as git does", () => {
		writeFileSync(
			join(home, ".gitconfig"),
			"[include]\r\n\tpath = extra.inc\r\n[core]\r\n\teditor = vi\r\n",
		);
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe(
			`[include]\n\tpath = "${join(home, "extra.inc")}"\n[core]\n\teditor = vi\n`,
		);
	});

	it("reads a global file through a link or a second name only by its path, as the fence shows it", () => {
		// A key the fence hides by a rule of its own, not by the home list.
		mkdirSync(join(home, ".ssh"));
		writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
		const gitconfig = join(home, ".gitconfig");
		const byPath = `[include]\n\tpath = "${gitconfig}"\n`;
		rmSync(gitconfig);
		symlinkSync(join(home, ".ssh", "id_ed25519"), gitconfig);
		const linked = copiesOf("s-1");
		if (!linked) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(linked.git), "utf8"), "a link").toBe(
			byPath,
		);

		rmSync(gitconfig);
		linkSync(join(home, ".ssh", "id_ed25519"), gitconfig);
		pi = maker(200);
		const named = copiesOf("s-1");
		if (!named) throw new Error("no copies were made");
		expect(
			readFileSync(gitGlobalIn(named.git), "utf8"),
			"a second name for the key",
		).toBe(byPath);
	});

	it("copies the global file the person names in GIT_CONFIG_GLOBAL alone, as git reads it", () => {
		const named = join(base, "mine.gitconfig");
		writeFileSync(named, "[user]\n\tname = named\n");
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = unread\n");
		const copies = copiesOf("s-1", {
			XDG_RUNTIME_DIR: runtime,
			GIT_CONFIG_GLOBAL: named,
		});
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe(
			"[user]\n\tname = named\n",
		);
	});

	it("writes out no global file the fence hides at its own path", () => {
		writeFileSync(join(home, ".gitconfig"), "[secret]\n");
		pi = maker(100, [], "pid:[1]", [".gitconfig"]);
		const copies = copiesOf("s-1");
		if (!copies) throw new Error("no copies were made");
		expect(readFileSync(gitGlobalIn(copies.git), "utf8")).toBe("");
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
				"\tpath = commented.inc ; a note",
				'\tpath = "sp ace.inc" # a note',
				"\tpath = %(prefix)/etc/kept.inc",
				'[includeIf "gitdir:./src/"] path = here.inc',
				'[includeIf "gitdir/i:./Src/"]',
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
				`\tpath = "${join(home, "commented.inc")}"`,
				`\tpath = "${join(home, "sp ace.inc")}"`,
				"\tpath = %(prefix)/etc/kept.inc",
				`[includeIf "gitdir:${home}/src/"] path = "${join(home, "here.inc")}"`,
				`[includeIf "gitdir/i:${home}/Src/"]`,
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
			const copies = copiesOf("s-1");
			if (at.endsWith("s-1.100"))
				expect(copies?.dev, "a set beside the link").toBe(
					join(sessions, "s-1.100.1", "dev"),
				);
			else expect(copies, at).toBeUndefined();
			expect(readFileSync(join(victim, "kept"), "utf8")).toBe("kept\n");
			expect(readdirSync(victim), at).toEqual(["kept"]);
		}
	});

	it.skipIf(root)(
		"tries no more once the copies couldn't be made, so each command runs as before",
		() => {
			mkdirSync(join(runtime, "pi-fence"), { mode: 0o500 });
			expect(copiesOf("s-1")).toBeUndefined();
			chmodSync(join(runtime, "pi-fence"), 0o700);
			expect(
				copiesOf("s-1"),
				"a later command in the same pi tried again",
			).toBeUndefined();
			pi = maker(200);
			expect(copiesOf("s-1"), "the next pi tries afresh").toBeDefined();
		},
	);
});
