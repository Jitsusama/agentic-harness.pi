/**
 * A host's servers started by an older pi, while its conversations run
 * different versions through a reload: that pool starts every server
 * outside any fence, so a fenced session asks it nothing, and its end
 * asks it to stop no fence it never drew.
 */
import { afterEach, expect, it, vi } from "vitest";
import lspIntegration from "../../../extensions/lsp-integration/index.ts";
import { clearLspBackends } from "../../../lib/core/lsp/index.ts";
import { SANDBOX_VARIABLE } from "../../../lib/internal/sandbox/sandbox.ts";

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
// The pool as an older pi made it: no fences, so no `stopFence`.
const diagnostics = vi.hoisted(() => vi.fn(async () => []));
// What the lease hands other extensions in place of that pool.
const lease = vi.hoisted(() => ({
	registered: undefined as undefined | ((pool: never) => unknown),
	older: undefined as unknown,
}));
vi.mock("../../../lib/core/internal/lsp/standalone.ts", () => {
	const older = { name: "standalone", diagnostics };
	lease.older = older;
	return {
		standaloneLease: (registered?: (pool: never) => unknown) => {
			lease.registered = registered;
			return {
				ensure: () => older,
				current: () => older,
				release: async () => {},
				restart: async () => older,
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
	): Promise<{ content: { text: string }[]; details: { ok: boolean } }>;
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

afterEach(() => {
	vi.unstubAllEnvs();
	diagnostics.mockClear();
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

it("asks an older pi's servers nothing for a fenced session, saying why", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");

	const result = await call(lspTool().tool);

	expect(diagnostics).not.toHaveBeenCalled();
	expect(result.details.ok).toBe(false);
	expect(result.content[0]?.text).toContain("started by an older pi");
});

it("asks an older pi's servers nothing for another extension's call in a fenced session, saying why", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");
	await lspTool().on.get("session_start")?.({}, ctx);
	const others = lease.registered?.(lease.older as never) as
		| { diagnostics(path: string, options?: object): Promise<unknown> }
		| undefined;

	await expect(others?.diagnostics("/work/a.ts", {})).rejects.toThrow(
		"started by an older pi",
	);
	expect(diagnostics).not.toHaveBeenCalled();
});

it("ends a fenced session without asking an older pi's servers to stop its fence", async () => {
	vi.stubEnv(SANDBOX_VARIABLE, "strict");
	const { tool, on } = lspTool();
	await on.get("session_start")?.({}, ctx);
	await call(tool);

	await expect(
		on.get("session_shutdown")?.({ reason: "quit" }, ctx),
	).resolves.toBeUndefined();
});
