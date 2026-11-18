/**
 * The agent's commands through pi-spawner: a stand-in for the program,
 * two streams and an end, takes the requests and sends frames, so what
 * pi's bash sees is checked without starting anything.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	systemFolders,
	systemProgram,
} from "../../../../lib/internal/sandbox/system-program.ts";
import {
	type SpawnerOptions,
	type Started,
	spawnedBy,
	spawnerEnvironment,
	spawnerKeeps,
	startProgram,
	stopIdleSpawners,
} from "../../../../lib/internal/shell/spawner.ts";
import {
	inSpawnerScope,
	type ScopeSetting,
	settingHere,
	spawnerStart,
} from "../../../../lib/internal/shell/spawner-scope.ts";
import { SPAWNER_VARIABLE } from "../../../../lib/internal/shell/spawner-variable.ts";
import {
	type SpawnerStandIn,
	spawnerStandIn as standIn,
} from "../../../support/spawner-stand-in.ts";

const SHELL = { shell: "/bin/bash", args: ["-c"] };
/** How long the probe for a user manager that makes scopes may take. */
const SCOPE_PROBE_MS = 5000;

/** Puts pi's own environment's `name` back as `value` had it, unset where it was. */
function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** pi's own spawn as a stand-in, counting what fell back to it. */
function fallback(): BashOperations & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		exec: async (command) => {
			calls.push(command);
			return { exitCode: 0 };
		},
	};
}

/** The operations through a stand-in, asked for, with `over` on top. */
function through(over: Partial<SpawnerOptions> = {}) {
	const program = standIn();
	const own = fallback();
	const kill = vi.fn<(pid: number) => void>();
	const operations = spawnedBy(own, {
		env: { [SPAWNER_VARIABLE]: "on" },
		shell: SHELL,
		program: "/run/pi-spawner",
		start: program.start,
		kill,
		reap: () => undefined,
		...over,
	});
	return { program, own, kill, operations };
}

/** A turn of the event loop, so frames written are read and acted on. */
const delivered = () => new Promise((done) => setImmediate(done));

/** Wait until the stand-in has been asked `count` things. */
async function askedFor(program: SpawnerStandIn, count: number) {
	await vi.waitFor(() =>
		expect(program.asked.length, "requests the stand-in read").toBe(count),
	);
}

describe("the agent's commands through pi-spawner", () => {
	it("leaves pi's own spawn in place where it is turned off", async () => {
		const own = fallback();

		await spawnedBy(own, { env: { [SPAWNER_VARIABLE]: "off" } }).exec(
			"true",
			"/",
			{ onData: () => {}, env: {} },
		);

		expect(own.calls, "what pi's own spawn started").toEqual(["true"]);
	});

	it("starts each command through it where nothing says otherwise", async () => {
		const { program, own, operations } = through({ env: {} });

		void operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);

		expect(own.calls, "what pi's own spawn started").toEqual([]);
	});

	it("stops what an earlier load left as it is made, asked for or not", () => {
		for (const env of [{}, { [SPAWNER_VARIABLE]: "off" }]) {
			const reap = vi.fn<() => void>();
			spawnedBy(fallback(), { env, shell: SHELL, reap });
			expect(reap, JSON.stringify(env)).toHaveBeenCalledOnce();
		}
	});

	it("falls back to pi's own spawn where the system's profile has no program", async () => {
		const own = fallback();
		const operations = spawnedBy(own, {
			env: { [SPAWNER_VARIABLE]: "on" },
			shell: SHELL,
			find: () => undefined,
		});

		await operations.exec("true", "/", { onData: () => {}, env: {} });

		expect(own.calls).toEqual(["true"]);
	});

	it("never starts one planted in a folder the user can write, first on the PATH", async () => {
		const planted = mkdtempSync(join(tmpdir(), "planted-"));
		const fake = join(planted, "pi-spawner");
		writeFileSync(fake, "#!/bin/sh\nexit 0\n");
		chmodSync(fake, 0o755);
		const own = fallback();
		const start = vi.fn<NonNullable<SpawnerOptions["start"]>>();
		try {
			const operations = spawnedBy(own, {
				env: { [SPAWNER_VARIABLE]: "on", PATH: `${planted}:/usr/bin` },
				shell: SHELL,
				start,
				// The lookup itself, asked to look in the planted folder first.
				find: (name) => systemProgram(name, [planted, ...systemFolders()]),
			});

			await operations.exec("true", "/", { onData: () => {}, env: {} });

			expect(start, "the planted program was started").not.toHaveBeenCalledWith(
				fake,
			);
		} finally {
			rmSync(planted, { recursive: true, force: true });
		}
	});

	it("asks for the shell, folder and variables, and passes on what the command says", async () => {
		const { program, operations } = through();
		const heard: string[] = [];

		const ran = operations.exec("echo hi", "/", {
			onData: (data) => heard.push(data.toString()),
			env: { HOME: "/home/a", GONE: undefined },
		});
		await askedFor(program, 1);
		program.started(1, 4321);
		program.said(1, 1, "hi\n");
		program.said(1, 2, "warn\n");
		program.closed(1, 1);
		program.closed(1, 2);
		program.exited(1, 3);

		await expect(ran).resolves.toEqual({ exitCode: 3 });
		expect(program.asked[0]).toEqual([
			"run",
			"1",
			"/bin/bash",
			"/",
			"2",
			"-c",
			"echo hi",
			"1",
			"HOME=/home/a",
		]);
		expect(heard).toEqual(["hi\n", "warn\n"]);
	});

	it("counts an end by a signal as 128 and its number", async () => {
		const { program, operations } = through();

		const ran = operations.exec("sleep 9", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.started(1, 7);
		program.closed(1, 1);
		program.closed(1, 2);
		program.exited(1, -1, 9);

		await expect(ran).resolves.toEqual({ exitCode: 137 });
	});

	it("is done shortly after exit when something it left holds its output open", async () => {
		const { program, operations } = through();

		const ran = operations.exec("server &", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.started(1, 7);
		program.exited(1, 0);

		await expect(ran).resolves.toEqual({ exitCode: 0 });
		await askedFor(program, 2);
		expect(program.asked[1], "its output is dropped").toEqual(["drop", "1"]);
	});

	it("kills the command's group when stopped, and says it was", async () => {
		const { program, operations, kill } = through();
		const stop = new AbortController();

		const ran = operations.exec("sleep 9", "/", {
			onData: () => {},
			env: {},
			signal: stop.signal,
		});
		await askedFor(program, 1);
		program.started(1, 55);
		await delivered();
		stop.abort();
		program.closed(1, 1);
		program.closed(1, 2);
		program.exited(1, -1, 9);

		await expect(ran).rejects.toThrow("aborted");
		expect(kill).toHaveBeenCalledWith(55);
	});

	it("kills the command's group at its time limit, and says so as pi does", async () => {
		const { program, operations, kill } = through();
		kill.mockImplementation(() => {
			program.closed(1, 1);
			program.closed(1, 2);
			program.exited(1, -1, 9);
		});

		const ran = operations.exec("sleep 9", "/", {
			onData: () => {},
			env: {},
			timeout: 0.05,
		});
		await askedFor(program, 1);
		program.started(1, 66);

		await expect(ran).rejects.toThrow("timeout:0.05");
		expect(kill).toHaveBeenCalledWith(66);
	});

	it("says why a command couldn't start", async () => {
		const { program, operations } = through();

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.failed(1, "No such file or directory (os error 2)");

		await expect(ran).rejects.toThrow("No such file or directory");
	});

	it("refuses a folder that isn't there, in pi's words", async () => {
		const { program, operations } = through();

		await expect(
			operations.exec("true", "/no/such/folder", { onData: () => {}, env: {} }),
		).rejects.toThrow("Working directory does not exist: /no/such/folder");
		expect(program.asked, "nothing is asked of the program").toEqual([]);
	});

	it("kills what ran when the program stops, then falls back to pi's own spawn", async () => {
		const { program, operations, own, kill } = through();

		const ran = operations.exec("sleep 9", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.started(1, 77);
		await delivered();
		program.stop();

		await expect(ran).rejects.toThrow("pi-spawner stopped");
		expect(kill).toHaveBeenCalledWith(77);
		await operations.exec("true", "/", { onData: () => {}, env: {} });
		expect(own.calls).toEqual(["true"]);
	});
});

describe("whether a kept command outlives pi's going", () => {
	it("does through pi's own spawn, where pi-spawner is turned off", async () => {
		const asksKeeps = vi.fn(async () => false);

		const spared = await spawnedBy(fallback(), {
			env: { [SPAWNER_VARIABLE]: "off" },
			asksKeeps,
			reap: () => undefined,
		}).spares();

		expect(spared, "pi's own spawn leaves it running").toBe(true);
		expect(asksKeeps, "no program to ask").not.toHaveBeenCalled();
	});

	it("does where the system's profile has no program", async () => {
		const operations = spawnedBy(fallback(), {
			env: { [SPAWNER_VARIABLE]: "on" },
			shell: SHELL,
			find: () => undefined,
			asksKeeps: async () => false,
			reap: () => undefined,
		});

		expect(await operations.spares(), "no program, so pi's own spawn").toBe(
			true,
		);
	});

	it("does through pi-spawner only when it says it keeps, asked once", async () => {
		for (const keeps of [true, false]) {
			const asksKeeps = vi.fn(async () => keeps);
			const { operations } = through({ asksKeeps });

			const answers = await Promise.all([
				operations.spares(),
				operations.spares(),
			]);

			expect(answers, `a spawner that keeps: ${keeps}`).toEqual([keeps, keeps]);
			expect(asksKeeps).toHaveBeenCalledExactlyOnceWith("/run/pi-spawner");
		}
	});

	it("asks the program it starts, though the profile's link moves between the two", async () => {
		// Resolved, since the temporary folder may itself sit behind a link.
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "spawner-link-")));
		try {
			for (const one of ["old", "new"]) {
				mkdirSync(join(dir, one));
				writeFileSync(join(dir, one, "pi-spawner"), "");
			}
			const link = join(dir, "pi-spawner");
			symlinkSync(join(dir, "new", "pi-spawner"), link);
			const program = standIn();
			const start = vi.fn((_program: string) => program.start());
			const asksKeeps = vi.fn(async (_program: string) => true);
			const { operations } = through({ program: link, start, asksKeeps });

			await operations.spares();
			rmSync(link);
			symlinkSync(join(dir, "old", "pi-spawner"), link);
			void operations.exec("true", "/", { onData: () => {}, env: {} });

			const asked = join(dir, "new", "pi-spawner");
			expect(asksKeeps, "asked where the link led").toHaveBeenCalledWith(asked);
			expect(start, "started the one it asked").toHaveBeenCalledWith(
				asked,
				undefined,
				undefined,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does once pi-spawner is retired, since pi's own spawn starts what follows", async () => {
		const { operations } = through({ asksKeeps: async () => false });

		operations.retire();

		expect(await operations.spares(), "retired, so pi's own spawn").toBe(true);
	});
});

describe("asking a pi-spawner whether it keeps", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	/** A program at a path of its own, running `script` under sh. */
	function programOf(script: string): string {
		const dir = mkdtempSync(join(tmpdir(), "spawner-keeps-"));
		made.push(dir);
		const program = join(dir, "pi-spawner");
		writeFileSync(program, `#!/bin/sh\n${script}\n`);
		chmodSync(program, 0o755);
		return program;
	}

	it("hears yes from one that answers keeps", async () => {
		const program = programOf('[ "$1" = keeps ] && echo keeps');

		expect(await spawnerKeeps(program), "it answered keeps").toBe(true);
	});

	it("hears no from one that refuses the word, as one from before does", async () => {
		const program = programOf("echo 'x it takes no keeps' >&2; exit 64");

		expect(await spawnerKeeps(program), "it refused the word").toBe(false);
	});

	it("hears no from one that reads its empty input and says nothing", async () => {
		const program = programOf("cat >/dev/null");

		expect(await spawnerKeeps(program), "it said nothing").toBe(false);
	});

	it("names no session to it, whatever pi's environment names", async () => {
		const program = programOf(
			'[ "$1" = keeps ] && ! printenv PI_SPAWNER_SESSION >/dev/null && echo keeps',
		);
		const before = process.env.PI_SPAWNER_SESSION;
		process.env.PI_SPAWNER_SESSION = "s-host";
		try {
			expect(await spawnerKeeps(program), "it was told no session").toBe(true);
		} finally {
			restore("PI_SPAWNER_SESSION", before);
		}
	});

	it("hears no from one that isn't there", async () => {
		expect(
			await spawnerKeeps("/no/such/pi-spawner"),
			"no program at that path",
		).toBe(false);
	});
});

describe("the quest a pi-spawner's work is filed under", () => {
	const FIRST = "QEST-20261116-AAAAAA";
	const SECOND = "QEST-20261116-BBBBBB";

	/** A start handing out `programs` in turn, keeping the quest each was named. */
	function starting(...programs: SpawnerStandIn[]) {
		const quests: (string | undefined)[] = [];
		const start = (_program: string, quest?: string) => {
			quests.push(quest);
			const next = programs.shift();
			if (!next) throw new Error("started more often than stood in for");
			return next.start();
		};
		return { quests, start };
	}

	it("is the quest of the first command it runs", async () => {
		const program = standIn();
		const { quests, start } = starting(program);
		const { operations } = through({ start });

		void operations.exec("true", "/", {
			onData: () => {},
			env: { PI_QUEST: FIRST },
		});
		await askedFor(program, 1);

		expect(quests, "the quests each pi-spawner was started with").toEqual([
			FIRST,
		]);
	});

	it("starts another for another quest's command, closing the first once its own end", async () => {
		const first = standIn();
		const second = standIn();
		const { quests, start } = starting(first, second);
		const { operations } = through({ start });
		const job = operations.exec("sleep 60", "/", {
			onData: () => {},
			env: { PI_QUEST: FIRST },
		});
		await askedFor(first, 1);
		first.started(1, 20);
		await delivered();

		const next = operations.exec("true", "/", {
			onData: () => {},
			env: { PI_QUEST: SECOND },
		});
		await askedFor(second, 1);
		expect(quests, "the quests each pi-spawner was started with").toEqual([
			FIRST,
			SECOND,
		]);
		expect(first.hungUp(), "closed under its job").toBe(false);

		first.closed(1, 1);
		first.closed(1, 2);
		first.exited(1, 0);
		await expect(job).resolves.toEqual({ exitCode: 0 });
		expect(first.hungUp(), "closed once its job ended").toBe(true);
		first.stop();
		second.ends(1, 21);
		await next;

		void operations.exec("true", "/", {
			onData: () => {},
			env: { PI_QUEST: SECOND },
		});
		await askedFor(second, 2);
		expect(quests, "the same quest's command went to the same one").toEqual([
			FIRST,
			SECOND,
		]);
	});
});

describe("the session a pi-spawner is started naming", () => {
	/** A start keeping the session each pi-spawner was named for, in turn. */
	function naming(...programs: SpawnerStandIn[]) {
		const sessions: (string | undefined)[] = [];
		const start = (_program: string, _quest?: string, session?: string) => {
			sessions.push(session);
			const next = programs.shift();
			if (!next) throw new Error("started more often than stood in for");
			return next.start();
		};
		return { sessions, start };
	}

	it("is each load's own", async () => {
		const [one, two] = [standIn(), standIn()];
		const first = naming(one);
		const second = naming(two);

		for (const { operations, program } of [
			{
				operations: through({ start: first.start, session: "s-one" })
					.operations,
				program: one,
			},
			{
				operations: through({ start: second.start, session: "s-two" })
					.operations,
				program: two,
			},
		]) {
			void operations.exec("true", "/", { onData: () => {}, env: {} });
			await askedFor(program, 1);
		}

		expect(first.sessions, "the first load's spawner").toEqual(["s-one"]);
		expect(second.sessions, "the second load's spawner").toEqual(["s-two"]);
	});

	it("is still the load's own when another quest's command starts the next", async () => {
		const [before, after] = [standIn(), standIn()];
		const { sessions, start } = naming(before, after);
		const { operations } = through({ start, session: "s-one" });

		void operations.exec("true", "/", {
			onData: () => {},
			env: { PI_QUEST: "QEST-20261116-AAAAAA" },
		});
		await askedFor(before, 1);
		void operations.exec("true", "/", {
			onData: () => {},
			env: { PI_QUEST: "QEST-20261116-BBBBBB" },
		});
		await askedFor(after, 1);

		expect(sessions, "each spawner the load started").toEqual([
			"s-one",
			"s-one",
		]);
	});

	it("is put in its environment, and one inherited is dropped when none is named", () => {
		const inherited = { PATH: "/bin", PI_SPAWNER_SESSION: "s-host" };

		expect(spawnerEnvironment(inherited, "QEST-1", "s-one")).toEqual({
			PATH: "/bin",
			PI_QUEST: "QEST-1",
			PI_SPAWNER_SESSION: "s-one",
		});
		expect(spawnerEnvironment(inherited)).toEqual({ PATH: "/bin" });
	});

	it("is none for a load that names none, whatever pi's or a command's own environment names", async () => {
		const program = standIn();
		const { sessions, start } = naming(program);
		const { operations } = through({ start });
		const inherited = process.env.PI_SPAWNER_SESSION;
		process.env.PI_SPAWNER_SESSION = "s-host";
		try {
			void operations.exec("true", "/", {
				onData: () => {},
				env: { PI_SPAWNER_SESSION: "s-command" },
			});
			await askedFor(program, 1);
		} finally {
			restore("PI_SPAWNER_SESSION", inherited);
		}

		expect(sessions, "the spawner the load started").toEqual([undefined]);
	});
});

describe("a load's pi-spawner once the load is over", () => {
	it("is closed at once when it runs nothing", async () => {
		const { program, operations } = through();
		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.ends(1, 10);
		await ran;

		operations.retire();

		expect(program.hungUp(), "its input was ended").toBe(true);
	});

	it("lasts through a reload until the command it runs ends", async () => {
		const earlier = through();
		const job = earlier.operations.exec("sleep 60", "/", {
			onData: () => {},
			env: {},
		});
		await askedFor(earlier.program, 1);
		earlier.program.started(1, 20);
		await delivered();

		// The reload: the earlier load is over, and the next one starts its own.
		earlier.operations.retire();
		const reap = vi.fn<() => void>();
		const later = through({ reap });
		const next = later.operations.exec("true", "/", {
			onData: () => {},
			env: {},
		});
		await askedFor(later.program, 1);

		expect(earlier.program.hungUp(), "closed under its job").toBe(false);
		expect(
			reap,
			"the later load looked for what was left",
		).toHaveBeenCalledOnce();
		earlier.program.closed(1, 1);
		earlier.program.closed(1, 2);
		earlier.program.exited(1, 0);
		await expect(job).resolves.toEqual({ exitCode: 0 });
		expect(earlier.program.hungUp(), "closed once its job ended").toBe(true);
		later.program.ends(1, 21);
		await next;
		expect(later.program.hungUp(), "the later load's own").toBe(false);
	});

	it("starts later commands as pi's own", async () => {
		const { program, operations, own } = through();

		operations.retire();
		await operations.exec("true", "/", { onData: () => {}, env: {} });

		expect(own.calls).toEqual(["true"]);
		expect(program.asked, "nothing is asked of the program").toEqual([]);
	});
});

describe("the pi-spawners an earlier load left", () => {
	/** A /proc of processes, each with its command name and children. */
	function procOf(
		processes: Record<number, { comm: string; children: number[] }>,
	): string {
		const root = mkdtempSync(join(tmpdir(), "proc-"));
		for (const [pid, { comm, children }] of Object.entries(processes)) {
			mkdirSync(join(root, pid, "task", pid), { recursive: true });
			writeFileSync(join(root, pid, "comm"), `${comm}\n`);
			writeFileSync(
				join(root, pid, "task", pid, "children"),
				children.map((child) => `${child} `).join(""),
			);
		}
		return root;
	}

	it("are stopped when they run nothing, and only they", () => {
		const proc = procOf({
			100: { comm: "node", children: [200, 300, 400, 500] },
			200: { comm: "pi-spawner", children: [] },
			300: { comm: "pi-spawner", children: [301] },
			301: { comm: "bash", children: [] },
			400: { comm: "bash", children: [] },
		});
		const stopped: number[] = [];
		try {
			stopIdleSpawners(100, proc, (pid) => stopped.push(pid));
		} finally {
			rmSync(proc, { recursive: true, force: true });
		}

		expect(stopped).toEqual([200]);
	});
});

describe.skipIf(process.platform !== "linux")("a pi-spawner as started", () => {
	/**
	 * A pi-spawner saying its parent, its name, the session its starting
	 * environment names as it was started with (or none), and its cgroup.
	 */
	function sayingItself(): { folder: string; program: string } {
		const folder = mkdtempSync(join(tmpdir(), "started-spawner-"));
		const program = join(folder, "pi-spawner");
		writeFileSync(
			program,
			[
				"#!/bin/sh",
				'echo "$PPID"',
				'cat "/proc/$$/comm"',
				`named=$(tr '\\0' '\\n' < "/proc/$$/environ" | sed -n 's/^PI_SPAWNER_SESSION=//p')`,
				'[ -n "$named" ] || named=none',
				'echo "$named"',
				'cat "/proc/$$/cgroup"',
				"",
			].join("\n"),
		);
		chmodSync(program, 0o755);
		return { folder, program };
	}

	/** Everything `started` writes, until it ends. */
	async function saidBy(started: Started): Promise<string> {
		let said = "";
		const closed = new Promise((done) => started.output.once("close", done));
		started.output.on("data", (chunk: Buffer) => {
			said += chunk.toString("utf8");
		});
		await new Promise<void>((done) => started.ended(done));
		await closed;
		return said;
	}

	/**
	 * What a spawner started under `setting` says of itself, for `session`,
	 * while pi's own environment names another, as a host started below a
	 * spawner would.
	 */
	async function startedFor(
		session: string | undefined,
		setting: ScopeSetting,
	): Promise<{
		parent?: string;
		name?: string;
		named?: string;
		cgroup: string;
	}> {
		const inherited = process.env.PI_SPAWNER_SESSION;
		process.env.PI_SPAWNER_SESSION = "s-host";
		const { folder, program } = sayingItself();
		try {
			const said = await saidBy(
				startProgram(program, undefined, session, setting),
			);
			const [parent, name, named, ...cgroup] = said.trim().split("\n");
			return { parent, name, named, cgroup: cgroup.join("\n") };
		} finally {
			restore("PI_SPAWNER_SESSION", inherited);
			rmSync(folder, { recursive: true, force: true });
		}
	}

	it("is pi's own child, named pi-spawner, naming only its load's session", async () => {
		const setting = settingHere(false);
		const named = await startedFor("s-one", setting);
		const unnamed = await startedFor(undefined, setting);

		expect(named.parent, "its parent is pi").toBe(String(process.pid));
		expect(named.name, "the kernel's name for it").toBe("pi-spawner");
		expect(named.named, "what its own start names").toBe("s-one");
		expect(unnamed.named, "none, though pi's own names one").toBe("none");
	});

	// The suite's runtime folder is a sandbox (xdg-sandbox.ts), so this
	// reaches the account's own user manager, whose scope it makes is
	// collected as its pi-spawner ends; where none makes one, it is skipped.
	const ownRuntime = `/run/user/${process.getuid?.() ?? 0}`;
	const probe = spawnerStart("true", {
		...settingHere(true),
		env: { ...process.env, XDG_RUNTIME_DIR: ownRuntime },
	});
	const scopes =
		probe.unscoped === undefined &&
		spawnSync(probe.command, [...probe.args], {
			env: { ...process.env, XDG_RUNTIME_DIR: ownRuntime },
			stdio: "ignore",
			timeout: SCOPE_PROBE_MS,
		}).status === 0;

	it.skipIf(!scopes)(
		"is still the host's own child, named pi-spawner, naming only its session, in a scope",
		async () => {
			const sandboxed = process.env.XDG_RUNTIME_DIR;
			process.env.XDG_RUNTIME_DIR = ownRuntime;
			try {
				// Each its own setting, so each asks for a scope of its own name.
				const named = await startedFor("s-one", settingHere(true));
				const unnamed = await startedFor(undefined, settingHere(true));

				expect(named.parent, "its parent is the host").toBe(
					String(process.pid),
				);
				expect(named.name, "the kernel's name for it").toBe("pi-spawner");
				expect(named.named, "what its own start names").toBe("s-one");
				expect(unnamed.named, "none, though the host's own names one").toBe(
					"none",
				);
				expect(inSpawnerScope(named.cgroup), "it runs in its own scope").toBe(
					true,
				);
				expect(
					inSpawnerScope(unnamed.cgroup),
					"one naming none, in its own too",
				).toBe(true);
			} finally {
				restore("XDG_RUNTIME_DIR", sandboxed);
			}
		},
	);
});
