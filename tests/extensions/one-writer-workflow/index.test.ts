/**
 * Plain pi refuses a conversation a host holds, open or kept for its
 * next start: it says which host and how to reach it, takes no prompt,
 * and ends with HELD_ELSEWHERE_EXIT.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oneWriterWorkflow } from "../../../extensions/one-writer-workflow/index.ts";
import type { TickedOwner } from "../../../lib/internal/process-ticks.ts";
import { HELD_ELSEWHERE_EXIT } from "../../../lib/internal/session/one-writer.ts";

const held = "01a1be5c-fff0-70a1-9301-f505d5634bf6";

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
	}: { keeping?: string[]; host?: "running" | "gone" } = {},
) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	oneWriterWorkflow({
		dir: listDir(holding),
		rosters: rosterDir(keeping),
		standing: async (_owner: TickedOwner) => host,
		settleMs: 300,
	})(pi as never);
	return handlers;
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
		shutdown: vi.fn(),
		sessionManager: {
			getSessionId: () => session,
			getSessionFile: () => `/home/someone/.pi/sessions/${session}.jsonl`,
		},
	};
	return { ctx, said };
}

afterEach(() => {
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
