/**
 * An lsp call from a fenced session hands its backend the session's fence.
 *
 * The standalone backend starts each server through the fence it is
 * handed, so a call that handed none would run the project's code
 * outside the sandbox its commands run in. The fence starts the server
 * from the environment the session's commands get, and the servers it
 * started stop when the session ends. An editor's backend starts its
 * servers outside the fence, so a fenced call asks pi's own instead,
 * and a fenced server that died takes only its fence's servers with it.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import lspIntegration from "../../../extensions/lsp-integration/index.ts";
import {
	clearLspBackends,
	type LspCallOptions,
	registerLspBackend,
} from "../../../lib/core/lsp/index.ts";
import { OFF } from "../../../lib/internal/fence/fence-stage.ts";
import { SANDBOX_VARIABLE } from "../../../lib/internal/sandbox/sandbox.ts";
import { offerShellEnvironment } from "../../../lib/internal/shell/environment.ts";

// The sandbox a strict session's shell would draw, whether or not this
// machine has landrun, so the case means the same everywhere.
vi.mock("../../../lib/internal/sandbox/sandbox.ts", async (original) => {
	const real =
		await original<typeof import("../../../lib/internal/sandbox/sandbox.ts")>();
	return {
		...real,
		sandboxFor: () =>
			process.env[real.SANDBOX_VARIABLE] === "strict"
				? { kind: "strict", landrun: "/fenced/landrun" }
				: real.sandboxFor(),
	};
});
// pi's own servers, shared by the host's conversations, recording each
// call, and the editor's below them, which the calls reach unless
// fenced. A call the pool is to fail as a dead server's names its error.
const pool = vi.hoisted(() => ({
	stopFence: vi.fn(),
	dropFence: vi.fn(),
	restart: vi.fn(),
	failing: [] as Error[],
	handed: [] as unknown[],
	/** What the lease hands other extensions in place of the pool, as the extension wraps it. */
	registered: undefined as undefined | ((pool: never) => unknown),
	shared: undefined as unknown,
}));
vi.mock("../../../lib/core/internal/lsp/standalone.ts", () => {
	const shared = {
		stopFence: pool.stopFence,
		dropFence: pool.dropFence,
		diagnostics: async (_path: string, options?: unknown) => {
			pool.handed.push(options);
			const failure = pool.failing.shift();
			if (failure) throw failure;
			return [];
		},
	};
	pool.shared = shared;
	return {
		standaloneLease: (registered?: (pool: never) => unknown) => {
			pool.registered = registered;
			return {
				ensure: () => shared,
				current: () => shared,
				release: async () => {},
				restart: async () => {
					pool.restart();
					return shared;
				},
			};
		},
	};
});
vi.mock("../../../lib/internal/shell/ssh-guard.ts", async (original) => ({
	...(await original<
		typeof import("../../../lib/internal/shell/ssh-guard.ts")
	>()),
	readSshGuard: async () => ({ refuse: false, machines: [] }),
}));

interface Tool {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<unknown>;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** The lsp tool, as the extension registered it, and what it heard on. */
function lspTool(): { tool: Tool; on: Map<string, Handler> } {
	let found: Tool | undefined;
	const on = new Map<string, Handler>();
	lspIntegration({
		registerTool(definition: Tool) {
			found = definition;
		},
		on(event: string, handler: Handler) {
			on.set(event, handler);
		},
		events: { on() {}, emit() {} },
	} as never);
	if (!found) throw new Error("the lsp tool was not registered");
	return { tool: found, on };
}

let handed: (LspCallOptions | undefined)[];

beforeEach(() => {
	handed = [];
	clearLspBackends();
	registerLspBackend({
		name: "watching",
		priority: 1,
		isAvailable: () => true,
		backend: {
			name: "watching",
			diagnostics: async (_path: string, options?: LspCallOptions) => {
				handed.push(options);
				return [];
			},
		} as never,
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	pool.stopFence.mockClear();
	pool.dropFence.mockClear();
	pool.restart.mockClear();
	pool.failing.length = 0;
	pool.handed.length = 0;
	offerShellEnvironment("fenced-test", undefined);
	clearLspBackends();
});

const ctx = {
	cwd: "/work",
	sessionManager: { getSessionId: () => "s1" },
};

const call = (tool: Tool) =>
	tool.execute(
		"call",
		{ operation: "diagnostics", path: "/work/a.ts" },
		undefined,
		undefined,
		ctx,
	);

it("hands pi's own servers the session's fence where its commands run sandboxed, starting them as its commands start, and asks no editor's", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");
	offerShellEnvironment("fenced-test", () => ({ OFFERED: "to commands" }));

	await call(lspTool().tool);

	expect(handed).toHaveLength(0);
	const fenced = pool.handed as (LspCallOptions | undefined)[];
	expect(fenced).toHaveLength(1);
	expect(fenced[0]?.fence?.key).toBe("strict|s1");
	const launch = await fenced[0]?.fence?.launch(["tsserver"]);
	expect(launch && "env" in launch && launch.env).toMatchObject({
		PI_SESSION_ID: "s1",
		OFFERED: "to commands",
	});
});

it("hands none where its commands run as they are, and asks the editor's servers", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, OFF);

	await call(lspTool().tool);

	expect(pool.handed).toHaveLength(0);
	expect(handed).toHaveLength(1);
	expect(handed[0]?.fence).toBeUndefined();
});

it("drops only the fence's own servers when a fenced one died, and asks once more, never restarting the host's", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");
	pool.failing.push(new Error("Connection is closed."));

	const answer = await call(lspTool().tool);

	expect(answer).toMatchObject({ details: { ok: true } });
	expect(pool.dropFence).toHaveBeenCalledWith("strict|s1");
	expect(pool.restart).not.toHaveBeenCalled();
	expect(pool.handed).toHaveLength(2);
});

it("stops the servers started in a session's fence as the session ends", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");
	const { tool, on } = lspTool();
	await on.get("session_start")?.({}, ctx);
	await call(tool);

	await on.get("session_shutdown")?.({ reason: "quit" }, ctx);

	expect(pool.stopFence).toHaveBeenCalledWith("strict|s1");
});

/** The pool as another extension reaches it, verification's diagnostics say, once the session started. */
async function asOthersReachIt(): Promise<{
	diagnostics(path: string, options?: LspCallOptions): Promise<unknown>;
}> {
	const { on } = lspTool();
	await on.get("session_start")?.({}, ctx);
	const registered = pool.registered;
	if (!registered) throw new Error("the lease registers the pool as it is");
	return registered(pool.shared as never) as never;
}

it("hands the session's fence to a call another extension makes of pi's servers, which names none", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");

	await (await asOthersReachIt()).diagnostics("/work/a.ts", {});

	const fenced = pool.handed as (LspCallOptions | undefined)[];
	expect(fenced).toHaveLength(1);
	expect(fenced[0]?.fence?.key).toBe("strict|s1");
});

it("hands other extensions pi's servers as they are where its commands run as they are", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, OFF);

	expect(await asOthersReachIt()).toBe(pool.shared);
});
