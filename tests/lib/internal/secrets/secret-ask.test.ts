import { spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerOf,
	askRoute,
	asksAnswered,
	mayBeGiven,
	putAsk,
	type RouteReads,
	runsPasswords,
	type SecretAsk,
	takeAsk,
	withSecretNote,
} from "../../../../lib/internal/secrets/secret-ask.ts";

let dir: string;
let asks: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secret-ask-"));
	asks = join(dir, "secret-asks");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ask: SecretAsk = {
	session: "S1",
	quest: { id: "Q-1", title: "Try the line" },
	item: "op://Private/Release Test/password",
	why: "To try the line.",
	argv: ["secret-asks", "received"],
	tree: "/tmp/tree",
	given: "RELEASED",
	minutes: 1,
};

describe("an ask for a secret", () => {
	it("is written as the daemon's version 1 reads it", () => {
		const { id, file } = putAsk(asks, ask, () => 1_000);

		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(file).toBe(join(asks, `${id}.ask.json`));
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			version: 1,
			id,
			asked_ms: 1_000,
			session: "S1",
			quest: { id: "Q-1", title: "Try the line" },
			item: "op://Private/Release Test/password",
			why: "To try the line.",
			argv: ["secret-asks", "received"],
			tree: "/tmp/tree",
			given: "RELEASED",
			minutes: 1,
		});
	});

	it("says no quest as null", () => {
		const { file } = putAsk(asks, { ...ask, quest: undefined });

		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			quest: null,
		});
	});

	it("keeps its folder to Joel alone", () => {
		putAsk(asks, ask);

		expect((statSync(asks).mode & 0o777).toString(8)).toBe("700");
	});

	it("gets an id of its own each time", () => {
		const first = putAsk(asks, ask).id;
		const second = putAsk(asks, ask).id;

		expect(second).not.toBe(first);
	});

	it("is refused before it's written when the daemon would refuse it", () => {
		const refused: [Partial<SecretAsk>, RegExp][] = [
			[{ given: "PATH" }, /can't carry/],
			[{ given: "LD_PRELOAD" }, /can't carry/],
			[{ item: "Release Test" }, /op:\/\//],
			[{ argv: [] }, /command/],
			[{ minutes: 0 }, /1 to 30/],
			[{ minutes: 31 }, /1 to 30/],
			[{ why: "two\nlines" }, /one line/],
			[{ why: "x".repeat(201) }, /200/],
		];
		for (const [change, why] of refused) {
			expect(
				() => putAsk(asks, { ...ask, ...change }),
				JSON.stringify(change),
			).toThrow(why);
		}
		expect(readdirSync(dir)).toEqual([]);
	});

	it("is taken back whole, its answer with it", () => {
		const { id, file } = putAsk(asks, ask);
		writeFileSync(join(asks, `${id}.answer.json`), "{}");

		takeAsk(asks, id);

		expect(readdirSync(asks).filter((name) => name.startsWith(id))).toEqual([]);
		expect(() => statSync(file)).toThrow();
	});
});

describe("an ask's answer", () => {
	it("is nothing until the daemon writes it", () => {
		const { id } = putAsk(asks, ask);

		expect(answerOf(asks, id)).toBeUndefined();
	});

	it("says only its state, exit, why and output", () => {
		const { id } = putAsk(asks, ask);
		writeFileSync(
			join(asks, `${id}.answer.json`),
			JSON.stringify({
				version: 1,
				id,
				state: "ran",
				exit: 0,
				output: "RELEASED 12",
				cut: false,
				why: "",
				extra: "left out",
			}),
		);

		expect(answerOf(asks, id)).toEqual({
			state: "ran",
			exit: 0,
			output: "RELEASED 12",
			cut: false,
			why: "",
		});
	});

	it("says a refusal's why", () => {
		const { id } = putAsk(asks, ask);
		writeFileSync(
			join(asks, `${id}.answer.json`),
			JSON.stringify({
				version: 1,
				id,
				state: "refused",
				why: "refused by Joel",
			}),
		);

		expect(answerOf(asks, id)).toEqual({
			state: "refused",
			why: "refused by Joel",
		});
	});

	it("is no answer when it's another ask's", () => {
		const { id } = putAsk(asks, ask);
		writeFileSync(
			join(asks, `${id}.answer.json`),
			JSON.stringify({ version: 1, id: "0".repeat(32), state: "ran" }),
		);

		expect(answerOf(asks, id)).toBeUndefined();
	});
});

describe("a variable's name", () => {
	it("carries a value only when no command's start reads it", () => {
		for (const name of ["PATH", "HOME", "LANG", "BASH_ENV", "ENV", "SHELL"]) {
			expect(mayBeGiven(name), name).toBe(false);
		}
		for (const name of [
			"LD_PRELOAD",
			"lower",
			"1ST",
			"A-B",
			"",
			"A".repeat(65),
		]) {
			expect(mayBeGiven(name), JSON.stringify(name)).toBe(false);
		}
		expect(mayBeGiven("PACKAGE_TOKEN"), "a plain name").toBe(true);
		expect(mayBeGiven("_X1"), "an underscore first").toBe(true);
	});
});

describe("askRoute", () => {
	const runtimeDir = "/run/user/1000";
	const socket = "/run/user/1000/daemons/secret-asks.sock";
	const sign = "/run/user/1000/secret-asks/answering";

	/** A machine with only these files, and the passwords daemon at these pids. */
	function machine(
		files: Readonly<Record<string, string>>,
		daemons: readonly number[] = [],
	): RouteReads {
		return {
			exists: (path) => path in files,
			read: (path) => files[path],
			daemon: (pid) => daemons.includes(pid),
		};
	}

	it("files in the runtime folder's asks from a fenced session where the daemon runs", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [socket]: "" }),
		);
		expect(route).toEqual({ folder: "/run/user/1000/secret-asks" });
	});

	it("files there where the passwords daemon's sign names a running pid", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [sign]: "4242\n" }, [4242]),
		);
		expect(route).toEqual({ folder: "/run/user/1000/secret-asks" });
	});

	it("files there by the old daemon's socket, whatever sign is left beside it", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [socket]: "", [sign]: "4242\n" }),
		);
		expect(route).toEqual({ folder: "/run/user/1000/secret-asks" });
	});

	it("refuses where the sign was left by a daemon that runs no more", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [sign]: "4242\n" }, [17]),
		);
		expect("refused" in route && route.refused).toMatch(
			/neither does on this machine/,
		);
	});

	it("refuses a sign that holds no pid", () => {
		for (const text of ["", "0\n", "-1\n", "4242 4243\n", "pid\n"]) {
			const route = askRoute(
				{ fenced: true, runtimeDir },
				machine({ [sign]: text }, [0, -1, 4242]),
			);
			expect("refused" in route, JSON.stringify(text)).toBe(true);
		}
	});

	it("refuses a session whose commands run outside the fence", () => {
		const route = askRoute(
			{ fenced: false, runtimeDir },
			machine({ [socket]: "" }),
		);
		expect("refused" in route && route.refused).toMatch(
			/outside the agent fence/,
		);
	});

	it("refuses where nothing answers asks", () => {
		const route = askRoute({ fenced: true, runtimeDir }, machine({}));
		expect("refused" in route && route.refused).toMatch(
			/neither does on this machine/,
		);
	});

	it("refuses with no runtime folder", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir: undefined },
			machine({ [socket]: "" }),
		);
		expect("refused" in route, "no folder to file in").toBe(true);
	});
});

describe("runsPasswords", () => {
	it("reads the name and the real uid the kernel gives", () => {
		const proc = join(dir, "proc");
		const runs = (
			pid: number,
			name: string,
			uids: string,
			state = "S (sleeping)",
		) => {
			mkdirSync(join(proc, String(pid)), { recursive: true });
			writeFileSync(
				join(proc, String(pid), "status"),
				`Name:\t${name}\nUmask:\t0077\nState:\t${state}\nUid:\t${uids}\n`,
			);
		};
		runs(42, "passwords", "1000\t1000\t1000\t1000");
		runs(43, "passwords", "1001\t1001\t1001\t1001");
		runs(44, "passwords", "1001\t1000\t1000\t1000");
		runs(45, "sleep", "1000\t1000\t1000\t1000");
		runs(46, "passwords-not", "1000\t1000\t1000\t1000");
		runs(48, "passwords", "1000\t1000\t1000\t1000", "Z (zombie)");
		expect(runsPasswords(42, proc, 1000), "our own account's daemon").toBe(
			true,
		);
		expect(runsPasswords(43, proc, 1000), "another account's").toBe(false);
		expect(
			runsPasswords(44, proc, 1000),
			"another account's, with ours effective",
		).toBe(false);
		expect(runsPasswords(45, proc, 1000), "another program").toBe(false);
		expect(runsPasswords(46, proc, 1000), "a name like it").toBe(false);
		expect(runsPasswords(47, proc, 1000), "no such pid").toBe(false);
		expect(runsPasswords(48, proc, 1000), "died, not yet reaped").toBe(false);
		expect(runsPasswords(42, proc, -1), "no account to compare").toBe(false);
		runs(49, "passwords", "1000\t1000\t1000\t1000", "X (dead)");
		expect(runsPasswords(49, proc, 1000), "dead").toBe(false);
	});

	// Root reads any exe link, non-dumpable or not, so the premise holds
	// only for an ordinary account, and only where fs.suid_dumpable isn't
	// 1, which would leave an unreadable program's process dumpable.
	const dumpsStayHidden = (): boolean => {
		if (process.platform !== "linux" || process.getuid?.() === 0) return false;
		try {
			return readFileSync("/proc/sys/fs/suid_dumpable", "utf8").trim() !== "1";
		} catch {
			return false;
		}
	};

	it.runIf(dumpsStayHidden())(
		"knows a running passwords program from any other of this account's",
		async () => {
			const program = join(dir, "passwords");
			copyFileSync(realpathSync("/bin/sh"), program);
			// Run from a file it can't read, the kernel makes it non-dumpable,
			// as core's daemon makes itself, so its exe can't be read even by
			// this account and only its status says what it is.
			chmodSync(program, 0o111);
			// The same shell from a file it can read stays dumpable, so its
			// exe reads: the control that shows the copy's mode alone hides it.
			const readable = join(dir, "readable");
			copyFileSync(realpathSync("/bin/sh"), readable);
			chmodSync(readable, 0o755);
			const runtime = mkdtempSync(join(tmpdir(), "answered-"));
			let failed: Error | undefined;
			// Each shell waits on its own read, so it starts no child to
			// outlive it. Both start inside the try, whose finally kills
			// whichever did.
			const started: ReturnType<typeof spawn>[] = [];
			const start = (file: string) => {
				const shell = spawn(file, ["-c", "read -r line"], {
					stdio: ["pipe", "ignore", "ignore"],
				});
				started.push(shell);
				shell.on("error", (why) => {
					failed = why;
				});
				// Listened for at once, so an exit can't come before the wait.
				const exited = new Promise((done) => shell.once("exit", done));
				return { shell, exited };
			};
			try {
				const { shell: daemon, exited } = start(program);
				const { shell: other } = start(readable);
				const pid = daemon.pid ?? 0;
				await expect
					.poll(() => failed ?? runsPasswords(pid), { timeout: 5000 })
					.toBe(true);
				const control = other.pid ?? 0;
				await expect
					.poll(
						() =>
							failed ??
							readFileSync(`/proc/${control}/status`, "utf8").includes(
								"Name:\treadable\n",
							),
						{ timeout: 5000 },
					)
					.toBe(true);
				expect(readlinkSync(`/proc/${control}/exe`), "a dumpable one's").toBe(
					realpathSync(readable),
				);
				expect(
					() => readlinkSync(`/proc/${pid}/exe`),
					"a non-dumpable process's exe",
				).toThrow(expect.objectContaining({ code: "EACCES" }));
				expect(runsPasswords(control), "the readable control").toBe(false);
				expect(runsPasswords(process.pid), "this process, node").toBe(false);
				mkdirSync(join(runtime, "secret-asks"));
				writeFileSync(join(runtime, "secret-asks", "answering"), `${pid}\n`);
				expect(asksAnswered(runtime), "its sign, read from the machine").toBe(
					true,
				);
				daemon.kill("SIGKILL");
				await exited;
				expect(asksAnswered(runtime), "the sign a killed daemon left").toBe(
					false,
				);
			} finally {
				for (const shell of started) shell.kill("SIGKILL");
				rmSync(runtime, { recursive: true, force: true });
			}
		},
		15_000,
	);
});

describe("asksAnswered", () => {
	it("reads a sign naming a process that isn't the daemon as nothing answering", () => {
		const runtime = mkdtempSync(join(tmpdir(), "answered-"));
		try {
			const folder = join(runtime, "secret-asks");
			mkdirSync(folder);
			writeFileSync(join(folder, "answering"), `${process.pid}\n`);
			expect(
				asksAnswered(runtime),
				"a sign naming this test's own process, which isn't the daemon",
			).toBe(false);
			expect(
				asksAnswered(runtime, {
					exists: () => false,
					read: () => `${process.pid}\n`,
					daemon: (pid) => pid === process.pid,
				}),
				"the same sign, where that pid is the daemon",
			).toBe(true);
		} finally {
			rmSync(runtime, { recursive: true, force: true });
		}
	});

	it("reads no sign as nothing answering", () => {
		const runtime = mkdtempSync(join(tmpdir(), "answered-"));
		try {
			expect(asksAnswered(runtime), "a runtime folder with no sign").toBe(
				false,
			);
		} finally {
			rmSync(runtime, { recursive: true, force: true });
		}
	});
});

describe("withSecretNote", () => {
	it("tells a command naming secret-asks of secret_run, then runs it", () => {
		const said = withSecretNote("secret-asks ask --item x");
		expect(said).toMatch(/^printf '%s\\n' .*secret_run.* >&2\n/);
		expect(
			said.endsWith("\nsecret-asks ask --item x"),
			"the command runs after",
		).toBe(true);
	});

	it("leaves a command alone that only names something like it", () => {
		for (const command of [
			"ls my-secret-asks",
			"cat secret-asks.md",
			"echo hi",
		]) {
			expect(withSecretNote(command), command).toBe(command);
		}
	});

	it("notes the program wherever it stands in a line", () => {
		expect(
			withSecretNote("x && secret-asks list"),
			"after another command",
		).toMatch(/secret_run/);
		expect(withSecretNote("$(secret-asks)"), "in a substitution").toMatch(
			/secret_run/,
		);
	});
});
