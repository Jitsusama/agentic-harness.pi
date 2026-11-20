/**
 * Handing a pi's window to what its holder starts next: who may, how the
 * holder is told, and how the pi goes quiet so its last frame stays.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	goQuiet,
	handingOf,
	toldHolder,
} from "../../../../lib/internal/session/hand-over.ts";
import { PARKED_EXIT } from "../../../../lib/internal/session/park.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** A holder running the pi `pid` itself, and its files' variables. */
function holderFor(pid: number) {
	const dir = mkdtempSync(join(tmpdir(), "hand-over-"));
	dirs.push(dir);
	writeFileSync(join(dir, "s.json"), JSON.stringify({ pid }));
	const wake = join(dir, "s.wake");
	const again = join(dir, "s.again");
	return {
		files: { wake, again },
		env: { MYCELIUM_WAKE: wake, MYCELIUM_AGAIN: again },
	};
}

const log = "/home/someone/.pi/sessions/s.jsonl";

describe("whether a pi may hand its window over", () => {
	it("may, run by its holder itself with a log, naming where it tells it", () => {
		const holder = holderFor(4242);

		expect(
			handingOf({
				env: holder.env,
				pid: 4242,
				args: ["--session", log],
				sessionFile: log,
			}),
		).toEqual({ files: holder.files, sessionFile: log });
	});

	it("may not when its holder runs some other process", () => {
		const holder = holderFor(4242);

		expect(
			handingOf({ env: holder.env, pid: 4243, args: [], sessionFile: log }),
		).toBeUndefined();
	});

	it("may not with no holder's files to tell", () => {
		expect(
			handingOf({ env: {}, pid: 4242, args: [], sessionFile: log }),
		).toBeUndefined();
	});

	it("may not before it has a log", () => {
		const holder = holderFor(4242);

		expect(
			handingOf({
				env: holder.env,
				pid: 4242,
				args: [],
				sessionFile: undefined,
			}),
		).toBeUndefined();
	});

	it("may not with a flag plain pi would drop falling back", () => {
		const holder = holderFor(4242);

		expect(
			handingOf({
				env: holder.env,
				pid: 4242,
				args: ["--offline"],
				sessionFile: log,
			}),
		).toBeUndefined();
	});
});

describe("telling the holder what starts next", () => {
	it("names the command and writes the wake", () => {
		const { files } = holderFor(4242);

		expect(
			toldHolder(files, ["pi", "--session", log], { view: true }),
			"the holder is told",
		).toBe(true);

		expect(JSON.parse(readFileSync(files.again, "utf8"))).toEqual([
			"pi",
			"--session",
			log,
		]);
		expect(JSON.parse(readFileSync(files.wake, "utf8"))).toEqual({
			view: true,
		});
	});

	it("leaves no wake when the command can't be written", () => {
		const { files } = holderFor(4242);
		mkdirSync(files.again);

		expect(
			toldHolder(files, ["pi"], { view: true }),
			"a command it couldn't write tells nothing",
		).toBe(false);

		expect(existsSync(files.wake), "no wake").toBe(false);
	});

	it("takes the command back when the wake can't be written", () => {
		const { files } = holderFor(4242);
		mkdirSync(files.wake);

		expect(
			toldHolder(files, ["pi"], { view: true }),
			"a wake it couldn't write tells nothing",
		).toBe(false);

		expect(existsSync(files.again), "the command it wrote is gone").toBe(false);
	});
});

describe("going quiet", () => {
	it("writes nothing, reads no keys, keeps the terminal raw and ends as a park", async () => {
		const out = process.stdout.write;
		const err = process.stderr.write;
		const raw = process.stdin.setRawMode;
		const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const code = process.exitCode;
		const before = process.listeners("exit");
		const drawn = vi.fn(() => true);
		const cooked = vi.fn(() => process.stdin);
		const pause = vi
			.spyOn(process.stdin, "pause")
			.mockReturnValue(process.stdin);
		// Stand-ins for the terminal pi draws on, so what reaches it shows.
		process.stdout.write = drawn;
		process.stderr.write = drawn;
		Object.defineProperty(process.stdin, "isTTY", {
			value: true,
			configurable: true,
		});
		process.stdin.setRawMode = cooked;
		try {
			goQuiet();
			const flushed = new Promise<void>((resolve) => {
				process.stdout.write("a frame", () => resolve());
			});
			process.stderr.write("a resume hint");
			process.stdin.setRawMode(false);

			expect(drawn, "nothing reaches the terminal").not.toHaveBeenCalled();
			await expect(flushed, "a write's callback still runs").resolves.toBe(
				undefined,
			);
			expect(cooked, "the terminal stays raw").not.toHaveBeenCalled();
			expect(pause, "no key is read").toHaveBeenCalledOnce();
			const added = process
				.listeners("exit")
				.filter((one) => !before.includes(one));
			expect(added, "one exit listener sets the code").toHaveLength(1);
			(added[0] as () => void)();
			expect(process.exitCode, "it ends as a park").toBe(PARKED_EXIT);
		} finally {
			for (const one of process.listeners("exit"))
				if (!before.includes(one)) process.off("exit", one);
			process.stdout.write = out;
			process.stderr.write = err;
			process.stdin.setRawMode = raw;
			if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
			else Object.defineProperty(process.stdin, "isTTY", tty);
			process.exitCode = code;
		}
	});
});
