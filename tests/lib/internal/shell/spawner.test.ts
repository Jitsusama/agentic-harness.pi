/**
 * The agent's commands through pi-spawner: a stand-in for the program,
 * two streams and an end, takes the requests and sends frames, so what
 * pi's bash sees is checked without starting anything.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type SpawnerOptions,
	spawnedBy,
	stopIdleSpawners,
} from "../../../../lib/internal/shell/spawner.ts";
import { SPAWNER_VARIABLE } from "../../../../lib/internal/shell/spawner-variable.ts";
import {
	systemFolders,
	systemProgram,
} from "../../../../lib/internal/system-program.ts";

const SHELL = { shell: "/bin/bash", args: ["-c"] };

/** A stand-in pi-spawner: what it was asked, and frames to answer with. */
function standIn() {
	const input = new PassThrough();
	const output = new PassThrough();
	let stopped: (() => void) | undefined;
	const asked: string[][] = [];
	let held = Buffer.alloc(0);
	input.on("data", (chunk: Buffer) => {
		held = Buffer.concat([held, chunk]);
		while (held.length >= 4 && held.length >= 4 + held.readUInt32LE(0)) {
			const length = held.readUInt32LE(0);
			const fields = held
				.subarray(4, 4 + length)
				.toString("utf8")
				.split("\0");
			asked.push(fields.slice(0, -1));
			held = held.subarray(4 + length);
		}
	});
	const frame = (kind: string, id: number, payload: Buffer) => {
		const head = Buffer.alloc(9);
		head[0] = kind.charCodeAt(0);
		head.writeUInt32LE(id, 1);
		head.writeUInt32LE(payload.length, 5);
		output.write(Buffer.concat([head, payload]));
	};
	const int32s = (...values: number[]) => {
		const bytes = Buffer.alloc(values.length * 4);
		for (const [at, value] of values.entries()) {
			bytes.writeInt32LE(value, at * 4);
		}
		return bytes;
	};
	return {
		asked,
		start: () => ({
			input,
			output,
			ended: (listener: () => void) => {
				stopped = listener;
			},
		}),
		started: (id: number, pid: number) => frame("p", id, int32s(pid)),
		said: (id: number, stream: 1 | 2, text: string) =>
			frame("o", id, Buffer.concat([Buffer.from([stream]), Buffer.from(text)])),
		closed: (id: number, stream: 1 | 2) =>
			frame("c", id, Buffer.from([stream])),
		exited: (id: number, code: number, signal = 0) =>
			frame("x", id, int32s(code, signal)),
		failed: (id: number, why: string) => frame("e", id, Buffer.from(why)),
		stop: () => stopped?.(),
		/** Whether pi ended its input, which tells the program to stop. */
		hungUp: () => input.writableEnded,
	};
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
async function askedFor(program: ReturnType<typeof standIn>, count: number) {
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

/** End command `id` on the stand-in, as pi-spawner would. */
function ends(program: ReturnType<typeof standIn>, id: number, pid: number) {
	program.started(id, pid);
	program.closed(id, 1);
	program.closed(id, 2);
	program.exited(id, 0);
}

describe("a load's pi-spawner once the load is over", () => {
	it("is closed at once when it runs nothing", async () => {
		const { program, operations } = through();
		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await askedFor(program, 1);
		ends(program, 1, 10);
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
		ends(later.program, 1, 21);
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
