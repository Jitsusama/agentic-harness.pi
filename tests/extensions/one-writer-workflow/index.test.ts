/**
 * Plain pi refuses a conversation a host holds, open or kept for its
 * next start: it says which host and how to reach it, takes no prompt,
 * and ends with HELD_ELSEWHERE_EXIT; or, in a window its holder runs
 * itself, hands that window to the host's view and ends as a park,
 * gone quiet so pi's last frame stays until the view draws over it.
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
import { oneWriterWorkflow } from "../../../extensions/one-writer-workflow/index.ts";
import type { TickedOwner } from "../../../lib/internal/process-ticks.ts";
import { HELD_ELSEWHERE_EXIT } from "../../../lib/internal/session/one-writer.ts";

const held = "01a1be5c-fff0-70a1-9301-f505d5634bf6";

/**
 * How often a test's pi went quiet to hand its window over: the real
 * goQuiet would silence this very process, so each pi counts instead.
 */
let quieted = 0;

/** What a test's pi did to end, in order: going quiet and shutting down. */
const steps: string[] = [];

type Handler = (event: unknown, ctx?: unknown) => unknown;

/**
 * The extension loaded into a stand-in pi, with `holding` on the list of
 * a host whose process is `host`, and `keeping` on that host's roster.
 */
function loaded(
	holding: string[],
	{
		keeping = holding,
		host = "running",
		process: own = { env: {}, pid: 1, args: [] },
	}: {
		keeping?: string[];
		host?: "running" | "gone";
		process?: { env: NodeJS.ProcessEnv; pid: number; args: string[] };
	} = {},
) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	oneWriterWorkflow({
		dir: listDir(holding),
		rosters: rosterDir(keeping),
		standing: async (_owner: TickedOwner) => host,
		parks: parkDir(),
		settleMs: 300,
		...own,
		quiet: () => {
			quieted += 1;
			steps.push("quiet");
		},
	})(pi as never);
	return handlers;
}

/**
 * A holder's files for a pi it runs itself as `pid`: its record, and
 * where that pi names what starts next and writes its wake.
 */
function holderFor(pid: number) {
	const dir = mkdtempSync(join(tmpdir(), "one-writer-holder-"));
	dirs.push(dir);
	writeFileSync(join(dir, "s.json"), JSON.stringify({ pid }));
	return {
		wake: join(dir, "s.wake"),
		again: join(dir, "s.again"),
		env: {
			MYCELIUM_WAKE: join(dir, "s.wake"),
			MYCELIUM_AGAIN: join(dir, "s.again"),
		},
	};
}

/** Exit listeners a test added, taken off after it whatever it checked. */
const listening: Array<(code: number) => void> = [];

/** The exit listener `run` adds, which pi's own end would call. */
async function exitListenerOf(run: () => Promise<unknown>) {
	const before = process.listeners("exit");
	await run();
	const added = process
		.listeners("exit")
		.filter((one) => !before.includes(one));
	listening.push(...added);
	return added;
}

/** The code `listener` leaves pi to exit with, put back after. */
function exitCodeFrom(listener: () => void): typeof process.exitCode {
	const code = process.exitCode;
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	listener();
	const left = process.exitCode;
	process.exitCode = code;
	process.off("exit", listener);
	return left;
}

/** A roster folder whose work-background host keeps `keeping`. */
function rosterDir(keeping: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "one-writer-rosters-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "work-background.json"),
		JSON.stringify({
			v: 1,
			key: "work-background",
			sessions: keeping.map((sessionId) => ({
				sessionId,
				file: `/home/someone/.pi/sessions/${sessionId}.jsonl`,
				cwd: "/home/someone/src/core.nix",
				attended: false,
				since: "2026-11-10T23:17:00.000Z",
			})),
		}),
	);
	return dir;
}

const dirs: string[] = [];

/** An empty park folder, so no test reads this machine's own parks. */
function parkDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "one-writer-parks-"));
	dirs.push(dir);
	return dir;
}

function listDir(holding: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "one-writer-ext-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "4100-141.json"),
		JSON.stringify({
			key: "work-background",
			owner: { pid: 4100, startedAt: 1_794_370_632_830, startTicks: 141 },
			sessions: holding.map((id) => ({
				id,
				state: "idle",
				since: "2026-11-10T23:17:00.000Z",
			})),
		}),
	);
	return dir;
}

/** A plain pi's context on `session`, counting what it was told and asked. */
function context(session: string, mode: "tui" | "print") {
	const said: string[] = [];
	const ctx = {
		mode,
		hasUI: mode === "tui",
		ui: { notify: (line: string) => said.push(line) },
		shutdown: vi.fn(() => {
			steps.push("shutdown");
		}),
		sessionManager: {
			getSessionId: () => session,
			getSessionFile: () => `/home/someone/.pi/sessions/${session}.jsonl`,
		},
	};
	return { ctx, said };
}

afterEach(() => {
	quieted = 0;
	steps.splice(0);
	for (const listener of listening.splice(0)) process.off("exit", listener);
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("a plain pi on a conversation a live host holds", () => {
	it("says which host holds it, ends, and takes no prompt", async () => {
		const handlers = loaded([held]);
		const { ctx, said } = context(held, "tui");
		const before = process.listeners("exit");

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const added = process
			.listeners("exit")
			.filter((one) => !before.includes(one));

		expect(said).toEqual([
			expect.stringContaining("is open in the work-background host"),
		]);
		expect(ctx.shutdown).toHaveBeenCalledOnce();
		expect(handlers.get("input")?.({ text: "hello" })).toEqual({
			action: "handled",
		});
		expect(added, "one exit listener sets the code").toHaveLength(1);
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const code = process.exitCode;
		(added[0] as () => void)();
		expect(process.exitCode).toBe(HELD_ELSEWHERE_EXIT);
		expect(write).toHaveBeenCalledWith(
			expect.stringContaining("which would give it a second writer"),
		);
		process.exitCode = code;
		process.off("exit", added[0] as () => void);
	});

	it("exits at once outside a terminal, where pi's shutdown would wait", async () => {
		const handlers = loaded([held]);
		const { ctx } = context(held, "print");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			// Kept from ending the test run; the code is what's checked.
		}) as never);
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		expect(exit).toHaveBeenCalledWith(HELD_ELSEWHERE_EXIT);
		expect(write).toHaveBeenCalledWith(
			expect.stringContaining("open in the work-background host"),
		);
	});
});

describe("a plain pi its holder runs, on a conversation a host holds", () => {
	const log = `/home/someone/.pi/sessions/${held}.jsonl`;

	it("hands its window to the host's view, gone quiet, and ends as a park", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			process: {
				env: { ...holder.env, PI_SANDBOX: "fence" },
				pid: 4242,
				args: ["--session", log, "--model", "opus"],
			},
		});
		const { ctx, said } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(said, "no notice the view would wipe at once").toEqual([]);
		expect(existsSync(holder.again), "it names what starts next").toBe(true);
		const next: string[] = JSON.parse(readFileSync(holder.again, "utf8"));
		expect(next[2]).toMatch(/\/scripts\/host-join\.ts$/);
		expect(next.slice(3)).toEqual([
			"--view",
			"--session",
			held,
			"--",
			"env",
			"PI_SANDBOX=fence",
			"pi",
			"--session",
			log,
			"--model",
			"opus",
		]);
		expect(JSON.parse(readFileSync(holder.wake, "utf8"))).toMatchObject({
			session: held,
			view: true,
		});
		expect(ctx.shutdown).toHaveBeenCalledOnce();
		expect(handlers.get("input")?.({ text: "hello" })).toEqual({
			action: "handled",
		});
		expect(quieted, "it goes quiet, which ends it as a park").toBe(1);
		expect(steps, "quiet before pi's shutdown can draw").toEqual([
			"quiet",
			"shutdown",
		]);
		expect(added, "no refusal's exit code").toEqual([]);
	});

	it("refuses as ever when a shell runs it, naming nothing next", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			process: { env: holder.env, pid: 4243, args: ["--session", log] },
		});
		const { ctx } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(existsSync(holder.again), "it names nothing to start next").toBe(
			false,
		);
		expect(existsSync(holder.wake), "it writes no wake").toBe(false);
		expect(quieted, "a refusal shows its line").toBe(0);
		expect(exitCodeFrom(added[0] as () => void)).toBe(HELD_ELSEWHERE_EXIT);
	});

	it("refuses as ever with flags plain pi would drop", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			process: {
				env: holder.env,
				pid: 4242,
				args: ["--session", log, "--offline"],
			},
		});
		const { ctx } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(
			existsSync(holder.again),
			"it names nothing to start next, which would drop the flag",
		).toBe(false);
		expect(quieted, "a refusal shows its line").toBe(0);
		expect(exitCodeFrom(added[0] as () => void)).toBe(HELD_ELSEWHERE_EXIT);
	});

	it("refuses as ever with a prompt, which the view would lose", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			process: {
				env: holder.env,
				pid: 4242,
				args: ["--session", log, "hello"],
			},
		});
		const { ctx } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(existsSync(holder.again), "it names nothing to start next").toBe(
			false,
		);
		expect(quieted, "a refusal shows its line").toBe(0);
		expect(exitCodeFrom(added[0] as () => void)).toBe(HELD_ELSEWHERE_EXIT);
	});

	it("refuses with the restart a stranded hold needs, handing nothing over", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([], {
			keeping: [held],
			process: { env: holder.env, pid: 4242, args: ["--session", log] },
		});
		const { ctx, said } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(said).toEqual([
			expect.stringContaining(
				"systemctl --user restart pi-host-work-background.service",
			),
		]);
		expect(existsSync(holder.again), "it names nothing to start next").toBe(
			false,
		);
		expect(quieted, "a refusal shows its line").toBe(0);
		expect(exitCodeFrom(added[0] as () => void)).toBe(HELD_ELSEWHERE_EXIT);
	});

	it("hands over a prompt it took at start-up when it resumes into the conversation later", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			process: {
				env: holder.env,
				pid: 4242,
				args: ["--session", log, "hello"],
			},
		});
		const { ctx } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "resume" }, ctx),
		);

		expect(existsSync(holder.again), "it names the view next").toBe(true);
		expect(quieted).toBe(1);
		expect(added).toEqual([]);
	});

	it("hands over a hold its host keeps while down, whose view waits for it", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			host: "gone",
			process: { env: holder.env, pid: 4242, args: ["--session", log] },
		});
		const { ctx } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(existsSync(holder.again), "it names the view next").toBe(true);
		expect(quieted).toBe(1);
		expect(added).toEqual([]);
	});

	it("refuses, writing no wake, when what starts next can't be written", async () => {
		const holder = holderFor(4242);
		mkdirSync(holder.again);
		const handlers = loaded([held], {
			process: { env: holder.env, pid: 4242, args: ["--session", log] },
		});
		const { ctx } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(existsSync(holder.wake), "it wrote no wake").toBe(false);
		expect(quieted, "a refusal shows its line").toBe(0);
		expect(exitCodeFrom(added[0] as () => void)).toBe(HELD_ELSEWHERE_EXIT);
	});

	it("refuses, naming nothing next, when its wake can't be written", async () => {
		const holder = holderFor(4242);
		mkdirSync(holder.wake);
		const handlers = loaded([held], {
			process: { env: holder.env, pid: 4242, args: ["--session", log] },
		});
		const { ctx, said } = context(held, "tui");

		const added = await exitListenerOf(async () =>
			handlers.get("session_start")?.({ reason: "startup" }, ctx),
		);

		expect(said).toEqual([
			expect.stringContaining("is open in the work-background host"),
		]);
		expect(existsSync(holder.again), "the words it wrote first are gone").toBe(
			false,
		);
		expect(quieted, "a refusal shows its line").toBe(0);
		expect(exitCodeFrom(added[0] as () => void)).toBe(HELD_ELSEWHERE_EXIT);
	});

	it("exits at once outside a terminal, handing nothing over", async () => {
		const holder = holderFor(4242);
		const handlers = loaded([held], {
			process: { env: holder.env, pid: 4242, args: ["--session", log] },
		});
		const { ctx } = context(held, "print");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			// Kept from ending the test run; the code is what's checked.
		}) as never);
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		expect(exit).toHaveBeenCalledWith(HELD_ELSEWHERE_EXIT);
		expect(existsSync(holder.again), "it names nothing to start next").toBe(
			false,
		);
	});
});

describe("a plain pi on a conversation a host keeps for its next start", () => {
	it("is refused while the host is down, naming how to reach it", async () => {
		const handlers = loaded([held], { host: "gone" });
		const { ctx } = context(held, "print");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			// Kept from ending the test run; the code is what's checked.
		}) as never);
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		expect(exit).toHaveBeenCalledWith(HELD_ELSEWHERE_EXIT);
		expect(write).toHaveBeenCalledWith(
			expect.stringContaining(
				"kept by the work-background host, which takes it up again as it starts",
			),
		);
		expect(write).toHaveBeenCalledWith(
			expect.stringContaining(
				`mycelium --realm work attach --host work-background --session ${held}`,
			),
		);
	});
});

describe("a plain pi on a conversation no host holds", () => {
	it("opens as ever and takes every prompt", async () => {
		const handlers = loaded(["019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a10"], {
			keeping: [],
		});
		const { ctx, said } = context(held, "tui");

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		expect(said).toEqual([]);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		expect(handlers.get("input")?.({ text: "hello" })).toBeUndefined();
	});

	it("is not looked up without a log", async () => {
		const handlers = loaded([held]);
		const { ctx } = context(held, "tui");
		const ephemeral = {
			...ctx,
			sessionManager: {
				...ctx.sessionManager,
				getSessionFile: () => undefined,
			},
		};

		await handlers.get("session_start")?.({ reason: "startup" }, ephemeral);

		expect(ctx.shutdown).not.toHaveBeenCalled();
	});
});
