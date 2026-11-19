/**
 * The agent's commands through pi-spawner: a stand-in for the program,
 * two streams and an end, takes the requests and sends frames, so what
 * pi's bash sees is checked without starting anything. Long because
 * every case drives the same stand-in program through the one link.
 */
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
	RESAY_MS,
	type SpawnerOptions,
	spawnedBy,
	spawnerKeeps,
	stopIdleSpawners,
} from "../../../../lib/internal/shell/spawner.ts";
import type { Spawned } from "../../../../lib/internal/shell/spawner-register.ts";
import { SPAWNER_VARIABLE } from "../../../../lib/internal/shell/spawner-variable.ts";
import {
	type SpawnerStandIn,
	spawnerStandIn as standIn,
} from "../../../support/spawner-stand-in.ts";

const SHELL = { shell: "/bin/bash", args: ["-c"] };

/** When every stand-in spawner started, as /proc would say it. */
const STARTED = 987_654;

/**
 * pi's own spawn as a stand-in, counting what fell back to it and the
 * time limit each was given; where `timesOut`, it runs out of time as
 * pi's own does.
 */
function fallback(timesOut = false): BashOperations & {
	calls: string[];
	limits: (number | undefined)[];
} {
	const calls: string[] = [];
	const limits: (number | undefined)[] = [];
	return {
		calls,
		limits,
		exec: async (command, _cwd, { timeout }) => {
			calls.push(command);
			limits.push(timeout);
			if (timesOut) throw new Error(`timeout:${timeout}`);
			return { exitCode: 0 };
		},
	};
}

/**
 * The operations through a stand-in, asked for, with `over` on top and
 * `own` as pi's own spawn.
 */
function through(over: Partial<SpawnerOptions> = {}, own = fallback()) {
	const program = standIn();
	const kill = vi.fn<(pid: number) => void>();
	const operations = spawnedBy(own, {
		env: { [SPAWNER_VARIABLE]: "on" },
		shell: SHELL,
		program: "/run/pi-spawner",
		start: program.start,
		kill,
		reap: () => undefined,
		startOf: async () => STARTED,
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

	it("ends a command at its limit though its spawner never says it started, settling once it is killed and gone", async () => {
		const { program, operations, kill } = through();
		const heard: string[] = [];

		const ran = operations.exec("sleep 9", "/", {
			onData: (data) => heard.push(data.toString()),
			env: {},
			timeout: 0.05,
		});
		const ended = expect(ran, "how the command ended").rejects.toThrow(
			"timeout:0.05",
		);
		let settled = false;
		void ran.catch(() => {
			settled = true;
		});
		await askedFor(program, 1);

		// Well past the 50 ms limit, which is what's measured.
		await new Promise((passed) => setTimeout(passed, 200));
		expect(settled, "settled before its command started").toBe(false);
		program.started(1, 88);
		await vi.waitFor(() =>
			expect(kill, "what was killed").toHaveBeenCalledWith(88),
		);
		program.said(1, 1, "late\n");
		await delivered();
		expect(settled, "settled before its command ended").toBe(false);
		program.closed(1, 1);
		program.closed(1, 2);
		program.exited(1, -1, 9);

		await ended;
		program.said(1, 1, "after\n");
		await delivered();
		expect(heard, "nothing reaches the call once its command is gone").toEqual([
			"late\n",
		]);
	});

	it("ends a command stopped before its spawner says it started, killing it once it does", async () => {
		const { program, operations, kill } = through();
		const stopping = new AbortController();

		const ran = operations.exec("sleep 9", "/", {
			onData: () => {},
			env: {},
			signal: stopping.signal,
		});
		const ended = expect(ran, "how the command ended").rejects.toThrow(
			"aborted",
		);
		let settled = false;
		void ran.catch(() => {
			settled = true;
		});
		await askedFor(program, 1);
		stopping.abort();

		await delivered();
		expect(settled, "settled before its command started").toBe(false);
		program.started(1, 89);
		await vi.waitFor(() =>
			expect(kill, "what was killed").toHaveBeenCalledWith(89),
		);
		program.closed(1, 1);
		program.closed(1, 2);
		program.exited(1, -1, 9);

		await ended;
	});

	it("retires a spawner that never says a command given up on started, its other commands running on, and starts another for the next", async () => {
		const first = standIn();
		const second = standIn();
		const programs = [first, second];
		const said: string[] = [];
		const { own, operations, kill } = through({
			givenUpGrace: 20,
			say: (line) => said.push(line),
			start: () => {
				const next = programs.shift();
				if (next === undefined) throw new Error("started too often");
				return { ...next.start(), pid: 4242 };
			},
		});
		const sibling = operations.exec("sleep 60", "/", {
			onData: () => {},
			env: {},
		});
		await askedFor(first, 1);
		first.started(1, 80);
		const stopping = new AbortController();

		const ran = operations.exec("sleep 9", "/", {
			onData: () => {},
			env: {},
			signal: stopping.signal,
		});
		await askedFor(first, 2);
		stopping.abort();

		await expect(ran, "how the command ended").rejects.toThrow("aborted");
		expect(said, "what the host's log was told").toEqual([
			expect.stringContaining("takes no more"),
		]);
		expect(kill, "the spawner and its other command").not.toHaveBeenCalled();
		expect(first.hungUp(), "closed under its other command").toBe(false);
		first.started(2, 90);
		await vi.waitFor(() =>
			expect(kill, "a start after it was given up on").toHaveBeenCalledWith(90),
		);
		expect(kill, "only the one given up on").toHaveBeenCalledTimes(1);

		const next = operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(second, 1);
		second.ends(1, 21);
		await expect(next, "the next command").resolves.toEqual({ exitCode: 0 });
		expect(own.calls, "what pi's own spawn started").toEqual([]);

		first.ends(1, 0);
		await expect(sibling, "the other command").resolves.toEqual({
			exitCode: 0,
		});
		first.ends(2, 137);
		await vi.waitFor(() =>
			expect(first.hungUp(), "closed once its commands ended").toBe(true),
		);
	});

	it("waits for a command given up on that its spawner says started late but within the grace, until it ends", async () => {
		const program = standIn();
		const { operations, kill } = through({
			givenUpGrace: 20,
			start: () => ({ ...program.start(), pid: 4242 }),
		});
		const stopping = new AbortController();
		let settled = false;

		const ran = operations
			.exec("sleep 9", "/", {
				onData: () => {},
				env: {},
				signal: stopping.signal,
			})
			.finally(() => {
				settled = true;
			});
		await askedFor(program, 1);
		stopping.abort();
		program.started(1, 90);
		await vi.waitFor(() =>
			expect(kill, "the command once started").toHaveBeenCalledWith(90),
		);
		// Past the grace, a started command is still waited for.
		await new Promise((done) => setTimeout(done, 60));
		expect(settled, "settled before the command ended").toBe(false);
		expect(program.hungUp(), "the spawner, retired").toBe(false);

		program.ends(1, 137);
		await expect(ran, "how the command ended").rejects.toThrow("aborted");
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
			timeout: 0.3,
		});
		const ended = expect(ran).rejects.toThrow("timeout:0.3");
		await askedFor(program, 1);
		program.started(1, 66);

		await ended;
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

describe("the node told the session a load's pi-spawner serves", () => {
	const SPAWNER_PID = 4242;

	/** A stand-in whose start says the process it runs as. */
	function asProcess(program: SpawnerStandIn) {
		return () => ({ ...program.start(), pid: SPAWNER_PID });
	}

	it("is told before the first command reaches the spawner", async () => {
		const program = standIn();
		let told: (() => void) | undefined;
		const register = vi.fn<
			(spawned: Spawned, session: string) => Promise<void>
		>(
			() =>
				new Promise((settle) => {
					told = settle;
				}),
		);
		const { operations } = through({
			start: asProcess(program),
			session: "s-one",
			register,
		});

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await vi.waitFor(() => expect(told, "the telling began").toBeDefined());
		await delivered();
		expect(program.asked, "asked before the node was told").toEqual([]);
		told?.();
		await askedFor(program, 1);
		program.ends(1, 10);
		await ran;

		expect(register, "what the node was told").toHaveBeenCalledExactlyOnceWith(
			{ pid: SPAWNER_PID, started: STARTED },
			"s-one",
		);
	});

	it("is told once a spawner, not once a command", async () => {
		const program = standIn();
		const register = vi.fn<
			(spawned: Spawned, session: string) => Promise<void>
		>(async () => undefined);
		const { operations } = through({
			start: asProcess(program),
			session: "s-one",
			register,
		});

		for (const id of [1, 2]) {
			const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
			await askedFor(program, id);
			program.ends(id, 10 + id);
			await ran;
		}

		expect(register, "tellings").toHaveBeenCalledOnce();
	});

	it("is told again of the spawner another quest's command starts", async () => {
		const first = standIn();
		const second = standIn();
		const starts = [
			() => ({ ...first.start(), pid: SPAWNER_PID }),
			() => ({ ...second.start(), pid: SPAWNER_PID + 1 }),
		];
		const register = vi.fn<
			(spawned: Spawned, session: string) => Promise<void>
		>(async () => undefined);
		const { operations } = through({
			start: () => {
				const next = starts.shift();
				if (next === undefined) throw new Error("started too often");
				return next();
			},
			session: "s-one",
			register,
		});

		const loads: [SpawnerStandIn, string][] = [
			[first, "QEST-20261118-AAAAAA"],
			[second, "QEST-20261118-BBBBBB"],
		];
		for (const [program, quest] of loads) {
			const ran = operations.exec("true", "/", {
				onData: () => {},
				env: { PI_QUEST: quest },
			});
			await askedFor(program, 1);
			program.ends(1, 10);
			await ran;
		}

		expect(register.mock.calls, "what the node was told").toEqual([
			[{ pid: SPAWNER_PID, started: STARTED }, "s-one"],
			[{ pid: SPAWNER_PID + 1, started: STARTED }, "s-one"],
		]);
	});

	it("is told again while the spawner runs, and no more once it ends", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const program = standIn();
			const register = vi.fn<
				(spawned: Spawned, session: string) => Promise<void>
			>(async () => undefined);
			const { operations } = through({
				start: asProcess(program),
				session: "s-one",
				register,
			});
			const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
			await askedFor(program, 1);
			program.ends(1, 10);
			await ran;

			vi.advanceTimersByTime(RESAY_MS);
			await vi.waitFor(() =>
				expect(register, "tellings, said again").toHaveBeenCalledTimes(2),
			);
			program.stop();
			vi.advanceTimersByTime(RESAY_MS * 3);
			await delivered();

			expect(register.mock.calls, "what the node was told").toEqual([
				[{ pid: SPAWNER_PID, started: STARTED }, "s-one"],
				[{ pid: SPAWNER_PID, started: STARTED }, "s-one"],
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still runs the command when the telling fails", async () => {
		const program = standIn();
		const { operations } = through({
			start: asProcess(program),
			session: "s-one",
			register: async () => {
				throw new Error("no node");
			},
		});

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.ends(1, 10);

		await expect(ran, "how the command ended").resolves.toEqual({
			exitCode: 0,
		});
	});

	it("leaves the waiting command to pi's own spawn when the spawner stops meanwhile", async () => {
		const program = standIn();
		let told: (() => void) | undefined;
		const { operations, own } = through({
			start: asProcess(program),
			session: "s-one",
			register: () =>
				new Promise((settle) => {
					told = settle;
				}),
		});

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await vi.waitFor(() => expect(told, "the telling began").toBeDefined());
		program.stop();
		await delivered();
		told?.();

		await expect(ran, "how the command ended").resolves.toEqual({
			exitCode: 0,
		});
		expect(own.calls, "what pi's own spawn ran").toEqual(["true"]);
	});

	it("runs the waiting command through its spawner when the load retires meanwhile, then closes it", async () => {
		const program = standIn();
		let told: (() => void) | undefined;
		const { operations, own } = through({
			start: asProcess(program),
			session: "s-one",
			register: () =>
				new Promise((settle) => {
					told = settle;
				}),
		});

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await vi.waitFor(() => expect(told, "the telling began").toBeDefined());
		operations.retire();
		told?.();
		await askedFor(program, 1);
		expect(program.hungUp(), "closed while it runs the command").toBe(false);
		program.ends(1, 10);

		await expect(ran, "how the command ended").resolves.toEqual({
			exitCode: 0,
		});
		expect(own.calls, "what pi's own spawn ran").toEqual([]);
		await vi.waitFor(() =>
			expect(program.hungUp(), "closed once it ran").toBe(true),
		);
	});

	it("counts the wait on the telling against the command's time limit", async () => {
		const program = standIn();
		const { operations } = through({
			start: asProcess(program),
			session: "s-one",
			register: () => new Promise<void>(() => undefined),
		});

		const ran = operations.exec("true", "/", {
			onData: () => {},
			env: {},
			timeout: 0.05,
		});

		await expect(ran, "how the command ended").rejects.toThrow("timeout:0.05");
		expect(program.asked, "what the spawner was asked").toEqual([]);
		operations.retire();
		await vi.waitFor(() =>
			expect(program.hungUp(), "closed, nothing holding it").toBe(true),
		);
	});

	it("gives its spawner only the time the wait left", async () => {
		const program = standIn();
		const waited = 400;
		const { operations, kill } = through({
			start: asProcess(program),
			session: "s-one",
			register: () => new Promise((settle) => setTimeout(settle, waited)),
		});
		kill.mockImplementation(() => {
			program.closed(1, 1);
			program.closed(1, 2);
			program.exited(1, -1, 9);
		});
		const began = performance.now();

		const ran = operations.exec("sleep 9", "/", {
			onData: () => {},
			env: {},
			timeout: 0.6,
		});
		await askedFor(program, 1);
		program.started(1, 66);

		await expect(ran, "how the command ended").rejects.toThrow("timeout:0.6");
		expect(kill, "what was killed").toHaveBeenCalledWith(66);
		// With the whole limit it would end about `waited` later, at 1000 ms.
		expect(performance.now() - began, "how long it ran").toBeLessThan(850);
	});

	it("gives pi's own spawn only the time the wait left, when its spawner stops meanwhile", async () => {
		const program = standIn();
		let told: (() => void) | undefined;
		const { operations, own } = through({
			start: asProcess(program),
			session: "s-one",
			register: () =>
				new Promise((settle) => {
					told = settle;
				}),
		});

		const ran = operations.exec("true", "/", {
			onData: () => {},
			env: {},
			timeout: 10,
		});
		await vi.waitFor(() => expect(told, "the telling began").toBeDefined());
		program.stop();
		await delivered();
		told?.();
		await ran;

		const [given] = own.limits;
		expect(given, "the limit pi's own spawn was given").toBeLessThan(10);
		expect(given, "the limit pi's own spawn was given").toBeGreaterThan(0);
	});

	it("says the limit asked for when pi's own spawn runs out of the time left", async () => {
		const program = standIn();
		let told: (() => void) | undefined;
		const { operations } = through(
			{
				start: asProcess(program),
				session: "s-one",
				register: () =>
					new Promise((settle) => {
						told = settle;
					}),
			},
			fallback(true),
		);

		const ran = operations.exec("true", "/", {
			onData: () => {},
			env: {},
			timeout: 10,
		});
		await vi.waitFor(() => expect(told, "the telling began").toBeDefined());
		program.stop();
		await delivered();
		told?.();

		await expect(ran, "how the command ended").rejects.toThrow(/^timeout:10$/);
	});

	it("ends as stopped a command stopped while it waited, though its spawner stopped too", async () => {
		const program = standIn();
		const { operations, own } = through({
			start: asProcess(program),
			session: "s-one",
			register: () => new Promise<void>(() => undefined),
		});
		const stopping = new AbortController();

		const ran = operations.exec("true", "/", {
			onData: () => {},
			env: {},
			signal: stopping.signal,
		});
		await delivered();
		program.stop();
		await delivered();
		stopping.abort();

		await expect(ran, "how the command ended").rejects.toThrow("aborted");
		expect(own.calls, "what pi's own spawn ran").toEqual([]);
	});

	it("refuses a time limit pi refuses before waiting on the telling", async () => {
		const program = standIn();
		const { operations } = through({
			start: asProcess(program),
			session: "s-one",
			register: () => new Promise<void>(() => undefined),
		});

		const ran = operations.exec("true", "/", {
			onData: () => {},
			env: {},
			timeout: -1,
		});

		await expect(ran, "how the command ended").rejects.toThrow(
			"Invalid timeout",
		);
	});

	it("says the start read as the spawner began, each time it's said", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const program = standIn();
			let now = STARTED;
			const startOf = vi.fn<(pid: number) => Promise<number>>(async () => now);
			const register = vi.fn<
				(spawned: Spawned, session: string) => Promise<void>
			>(async () => undefined);
			const { operations } = through({
				start: asProcess(program),
				session: "s-one",
				register,
				startOf,
			});
			const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
			await askedFor(program, 1);
			program.ends(1, 10);
			await ran;
			// The pid left to another process, as /proc would say it.
			now = STARTED + 1;

			vi.advanceTimersByTime(RESAY_MS);
			await vi.waitFor(() =>
				expect(register, "tellings, said again").toHaveBeenCalledTimes(2),
			);

			expect(register.mock.calls, "what the node was told").toEqual([
				[{ pid: SPAWNER_PID, started: STARTED }, "s-one"],
				[{ pid: SPAWNER_PID, started: STARTED }, "s-one"],
			]);
			expect(startOf, "starts read").toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs two quests' commands waiting on their tellings, each through its own spawner", async () => {
		const first = standIn();
		const second = standIn();
		const programs = [first, second];
		let starts = 0;
		const tellings: (() => void)[] = [];
		const { operations } = through({
			start: () => {
				const next = programs[starts];
				if (next === undefined) throw new Error("started too often");
				starts += 1;
				return { ...next.start(), pid: SPAWNER_PID + starts };
			},
			session: "s-one",
			register: () =>
				new Promise((settle) => {
					tellings.push(settle);
				}),
		});

		const ran = [
			operations.exec("true", "/", {
				onData: () => {},
				env: { PI_QUEST: "QEST-20261118-AAAAAA" },
			}),
			operations.exec("true", "/", {
				onData: () => {},
				env: { PI_QUEST: "QEST-20261118-BBBBBB" },
			}),
		];
		await vi.waitFor(() => expect(tellings, "tellings begun").toHaveLength(2));
		for (const told of tellings) told();
		await askedFor(first, 1);
		await askedFor(second, 1);
		first.ends(1, 10);
		second.ends(1, 11);

		await expect(Promise.all(ran), "how the commands ended").resolves.toEqual([
			{ exitCode: 0 },
			{ exitCode: 0 },
		]);
		expect(starts, "spawners started").toBe(2);
		expect(tellings, "tellings").toHaveLength(2);
		expect(first.hungUp(), "the retired one, once its command ran").toBe(true);
		expect(second.hungUp(), "the one serving now").toBe(false);
	});

	it("leaves a waiting command to pi's own spawn when its retired spawner stops meanwhile", async () => {
		const first = standIn();
		const second = standIn();
		const programs = [first, second];
		let starts = 0;
		const tellings: (() => void)[] = [];
		const { operations, own } = through({
			start: () => {
				const next = programs[starts];
				if (next === undefined) throw new Error("started too often");
				starts += 1;
				return { ...next.start(), pid: SPAWNER_PID + starts };
			},
			session: "s-one",
			register: () =>
				new Promise((settle) => {
					tellings.push(settle);
				}),
		});

		const waiting = operations.exec("echo first", "/", {
			onData: () => {},
			env: { PI_QUEST: "QEST-20261118-AAAAAA" },
		});
		const next = operations.exec("echo second", "/", {
			onData: () => {},
			env: { PI_QUEST: "QEST-20261118-BBBBBB" },
		});
		await vi.waitFor(() => expect(tellings, "tellings begun").toHaveLength(2));
		first.stop();
		await delivered();
		for (const told of tellings) told();
		await askedFor(second, 1);
		second.ends(1, 11);

		await expect(waiting, "how the waiting command ended").resolves.toEqual({
			exitCode: 0,
		});
		await next;
		expect(own.calls, "what pi's own spawn ran").toEqual(["echo first"]);
		expect(first.asked, "what the stopped spawner was asked").toEqual([]);
	});

	it("runs a waiting command through its retired spawner when the one serving now stops meanwhile", async () => {
		const first = standIn();
		const second = standIn();
		const programs = [first, second];
		let starts = 0;
		const tellings: (() => void)[] = [];
		const { operations, own } = through({
			start: () => {
				const next = programs[starts];
				if (next === undefined) throw new Error("started too often");
				starts += 1;
				return { ...next.start(), pid: SPAWNER_PID + starts };
			},
			session: "s-one",
			register: () =>
				new Promise((settle) => {
					tellings.push(settle);
				}),
		});

		const waiting = operations.exec("echo first", "/", {
			onData: () => {},
			env: { PI_QUEST: "QEST-20261118-AAAAAA" },
		});
		const next = operations.exec("echo second", "/", {
			onData: () => {},
			env: { PI_QUEST: "QEST-20261118-BBBBBB" },
		});
		await vi.waitFor(() => expect(tellings, "tellings begun").toHaveLength(2));
		second.stop();
		await delivered();
		for (const told of tellings) told();
		await askedFor(first, 1);
		first.ends(1, 10);

		await expect(waiting, "how the waiting command ended").resolves.toEqual({
			exitCode: 0,
		});
		await next;
		expect(own.calls, "what pi's own spawn ran").toEqual(["echo second"]);
	});

	it("stops waiting on the telling once the command is stopped", async () => {
		const program = standIn();
		const { operations } = through({
			start: asProcess(program),
			session: "s-one",
			register: () => new Promise<void>(() => undefined),
		});
		const stopping = new AbortController();

		const ran = operations.exec("true", "/", {
			onData: () => {},
			env: {},
			signal: stopping.signal,
		});
		await delivered();
		stopping.abort();

		await expect(ran, "how the command ended").rejects.toThrow("aborted");
		expect(program.asked, "what the spawner was asked").toEqual([]);
	});

	it("is told nothing for a load that names no session", async () => {
		const program = standIn();
		const register = vi.fn<
			(spawned: Spawned, session: string) => Promise<void>
		>(async () => undefined);
		const { operations } = through({ start: asProcess(program), register });

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		program.ends(1, 10);
		await ran;

		expect(register, "tellings").not.toHaveBeenCalled();
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
