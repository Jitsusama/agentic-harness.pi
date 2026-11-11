/**
 * Plain pi refuses a conversation a live host holds: it says which host,
 * takes no prompt, and ends with HELD_ELSEWHERE_EXIT.
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

/** The extension loaded into a stand-in pi, listing `holding` as held by a live host. */
function loaded(holding: string[]) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	// A list naming the conversation, whose host runs.
	const dir = listDir(holding);
	oneWriterWorkflow({
		dir,
		standing: async (_owner: TickedOwner) => "running",
	})(pi as never);
	return handlers;
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
			expect.stringContaining("open in the work-background host (pid 4100)"),
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
			expect.stringContaining("won't open it as a second writer"),
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

describe("a plain pi on a conversation no live host holds", () => {
	it("opens as ever and takes every prompt", async () => {
		const handlers = loaded(["019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a10"]);
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
