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
	it("writes nothing, reads no keys and ends as a park", () => {
		const out = process.stdout.write;
		const err = process.stderr.write;
		const code = process.exitCode;
		const before = process.listeners("exit");
		const pause = vi
			.spyOn(process.stdin, "pause")
			.mockReturnValue(process.stdin);
		try {
			goQuiet();
			const added = process
				.listeners("exit")
				.filter((one) => !before.includes(one));
			expect(process.stdout.write, "pi's frame stays").not.toBe(out);
			expect(process.stderr.write, "no resume hint").not.toBe(err);
			expect(
				process.stdout.write("a frame"),
				"a write still answers as written",
			).toBe(true);
			expect(
				process.stderr.write("a hint"),
				"a write still answers as written",
			).toBe(true);
			expect(pause).toHaveBeenCalledOnce();
			expect(added, "one exit listener sets the code").toHaveLength(1);
			(added[0] as () => void)();
			expect(process.exitCode).toBe(PARKED_EXIT);
			for (const one of added) process.off("exit", one);
		} finally {
			process.stdout.write = out;
			process.stderr.write = err;
			process.exitCode = code;
		}
	});
});
