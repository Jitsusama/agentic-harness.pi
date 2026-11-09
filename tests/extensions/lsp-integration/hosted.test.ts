/** Editor registries are session-owned while actual runners share the standalone pool. */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import lspIntegration from "../../../extensions/lsp-integration/index.ts";
import { standaloneLease } from "../../../lib/core/internal/lsp/standalone.ts";
import {
	clearLspBackends,
	registerLspBackend,
	resolveLspBackend,
	type StandaloneBackend,
	unregisterLspBackend,
} from "../../../lib/core/lsp/index.ts";
import { listLspBackends } from "../../../lib/core/lsp/registry.ts";
import {
	installHost,
	NoSessionInHost,
	releaseSession,
	withSession,
} from "../../../lib/core/session/index.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

const created = vi.hoisted(() => [] as StandaloneBackend[]);
vi.mock("../../../lib/core/lsp/index.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/core/lsp/index.ts")>()),
	createStandaloneBackend: () => {
		const backend = fakeBackend(`pool-${created.length}`);
		created.push(backend);
		return backend;
	},
}));

function fakeBackend(name: string): StandaloneBackend {
	return {
		name,
		diagnostics: vi.fn(async () => []),
		definition: async () => [],
		references: async () => [],
		hover: async () => null,
		documentSymbols: async () => [],
		workspaceSymbols: async () => [],
		rename: async () => ({ changes: [] }),
		codeActions: async () => [],
		dispose: vi.fn(async () => {}),
		serverCount: () => 0,
		syncDocument: () => {},
	};
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	created.length = 0;
	clearLspBackends();
});

function host() {
	cleanups.push(
		installHost({
			kind: "pi-durable",
			key: "test-lsp-host",
			owner: { pid: process.pid, startedAt: Date.now() },
			holds: () => "idle",
			env: () => {
				throw new Error(
					"LSP registry tests do not consume session environments",
				);
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
		}),
	);
}

function registry(id: string) {
	const ctx = {
		cwd: `/work/${id}`,
		sessionManager: { getSessionId: () => id },
	};
	cleanups.push(() => releaseSession(id));
	return ctx;
}

async function runner(cwd: string) {
	const manager = SessionManager.inMemory(cwd);
	const running = withSession(manager.getSessionId(), () =>
		extensionRunner(lspIntegration, cwd, manager),
	);
	const ctx = running.runner.createToolContext("test", undefined);
	const id = ctx.sessionManager.getSessionId();
	cleanups.push(() => releaseSession(id));
	cleanups.push(() => running.stop());
	await running.start();
	return { ...running, ctx };
}

function editor(backend: StandaloneBackend) {
	return { name: "editor", priority: 10, isAvailable: () => true, backend };
}

function diagnose(running: Awaited<ReturnType<typeof runner>>) {
	return running.call("lsp", { operation: "diagnostics", path: "a.ts" });
}

describe("hosted LSP registries", () => {
	it("keeps the original shared symbol and explicit-context parity on plain pi", () => {
		const a = registry("a");
		const b = registry("b");
		const backend = fakeBackend("legacy");
		registerLspBackend(editor(backend), a);
		expect(withSession("b", () => resolveLspBackend(b))).toBe(backend);
	});

	it("binds delayed provider notifications to the load context before startup", async () => {
		host();
		const manager = SessionManager.inMemory("/work/a");
		const id = manager.getSessionId();
		const a = withSession(id, () =>
			extensionRunner(lspIntegration, "/work/a", manager),
		);
		cleanups.push(() => releaseSession(id));
		cleanups.push(() => a.stop());
		const backend = fakeBackend("early-editor");
		withSession("b", () =>
			a.events.emit("lsp:register-backend", editor(backend)),
		);
		expect(resolveLspBackend(id)).toBe(backend);
		expect(resolveLspBackend(registry("b"))).toBeUndefined();
		await a.start();
		expect(resolveLspBackend(id)).toBe(backend);
	});
	it("keeps identical names separate, with explicit context outranking ambient context", () => {
		host();
		const a = registry("a");
		const b = registry("b");
		const backendA = fakeBackend("a");
		const backendB = fakeBackend("b");
		withSession("b", () => registerLspBackend(editor(backendA), a));
		registerLspBackend(editor(backendB), b);
		expect(resolveLspBackend(a)).toBe(backendA);
		expect(withSession("b", () => resolveLspBackend())).toBe(backendB);
		unregisterLspBackend("editor", a);
		expect(listLspBackends(a)).toEqual([]);
		expect(resolveLspBackend(b)).toBe(backendB);
		clearLspBackends(b);
		expect(resolveLspBackend(b)).toBeUndefined();
	});

	it("refuses an unscoped lookup instead of exposing the plain-pi registry", () => {
		registerLspBackend(editor(fakeBackend("legacy")));
		host();
		expect(() => resolveLspBackend()).toThrow(NoSessionInHost);
		expect(() => standaloneLease().ensure()).toThrow(NoSessionInHost);
		expect(created).toHaveLength(0);
		expect(resolveLspBackend(registry("a"))).toBeUndefined();
	});

	it("routes A to its editor and B to the pool, then keeps B alive after A closes", async () => {
		host();
		const a = await runner("/work/a");
		const b = await runner("/work/b");
		const backend = fakeBackend("editor-a");
		// An external notification belongs to the bus's runner, not whoever is ambient.
		withSession(b.ctx.sessionManager.getSessionId(), () =>
			a.events.emit("lsp:register-backend", editor(backend)),
		);
		await diagnose(a);
		await diagnose(b);
		expect(created).toHaveLength(1);
		expect(backend.diagnostics).toHaveBeenCalledWith(
			"/work/a/a.ts",
			expect.anything(),
		);
		expect(created[0].diagnostics).toHaveBeenCalledWith(
			"/work/b/a.ts",
			expect.anything(),
		);
		await a.stop();
		expect(listLspBackends(a.ctx)).toEqual([]);
		expect(backend.dispose).not.toHaveBeenCalled();
		expect(created[0].dispose).not.toHaveBeenCalled();
		await diagnose(b);
		expect(b.errors).toEqual([]);
		await b.stop();
		expect(created[0].dispose).toHaveBeenCalledOnce();
	});

	it("unregisters only the notifying runner's editor, even with identical backend names", async () => {
		host();
		const a = await runner("/work/a");
		const b = await runner("/work/b");
		const backendA = fakeBackend("a");
		const backendB = fakeBackend("b");
		a.events.emit("lsp:register-backend", editor(backendA));
		b.events.emit("lsp:register-backend", editor(backendB));
		a.events.emit("lsp:unregister-backend", { name: "editor" });
		expect(resolveLspBackend(a.ctx)).toBe(created[0]);
		expect(resolveLspBackend(b.ctx)).toBe(backendB);
		await a.stop();
		expect(resolveLspBackend(b.ctx)).toBe(backendB);
	});

	it("publishes a closed pool's replacement to the other runner without its startup event", async () => {
		host();
		const a = await runner("/work/a");
		const b = await runner("/work/b");
		const old = created[0];
		vi.mocked(old.diagnostics).mockRejectedValueOnce(
			new Error("Pending response rejected since connection got disposed"),
		);
		await diagnose(a);
		expect(created).toHaveLength(2);
		expect(old.dispose).toHaveBeenCalledOnce();
		expect(resolveLspBackend(b.ctx)).toBe(created[1]);
		await diagnose(b);
		expect(created[1].diagnostics).toHaveBeenCalledWith(
			"/work/b/a.ts",
			expect.anything(),
		);
		expect(b.errors).toEqual([]);
	});
});
