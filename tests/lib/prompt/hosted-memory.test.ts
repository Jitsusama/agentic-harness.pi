/** Actual memory contributors retain their own store when a sibling shuts down. */
import { afterEach, expect, it, vi } from "vitest";
import memoryIntegration from "../../../extensions/memory-integration/index.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { openMemoryStore } from "../../../lib/memory/index.ts";
import { createFrozenResidentPrompt } from "../../../lib/prompt/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { installTestHost } from "../../support/session-host.ts";

vi.mock("../../../lib/memory/index.ts", () => ({
	openMemoryStore: vi.fn(),
	memoryDbPath: async () => "unused-test-db",
	resolveScope: () => ({ kind: "global", id: "test" }),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	vi.clearAllMocks();
});

it("assembles B's remembered facts afresh after A's real shutdown handler closes its store", async () => {
	const installed = installTestHost();
	dispose = installed.dispose;
	const a = fakePi();
	const b = fakePi();
	const closedA = vi.fn();
	const closedB = vi.fn();
	// The storage transport is replaced; the extension's factory and lifecycle run.
	vi.mocked(openMemoryStore)
		.mockResolvedValueOnce({
			recall: async () => [{ text: "A's fact" }],
			close: closedA,
		} as never)
		.mockResolvedValueOnce({
			recall: async () => [{ text: "B's fact" }],
			close: closedB,
		} as never);
	withSession("a", () => memoryIntegration(a));
	withSession("b", () => memoryIntegration(b));
	for (const [id, pi] of [
		["a", a],
		["b", b],
	] as const) {
		for (const start of pi.recorded.handlers.get("session_start") ?? []) {
			await withSession(id, () => start({}, {}));
		}
	}
	const ctxB = {
		cwd: "/b",
		sessionManager: { getSessionId: () => "b" },
	} as never;
	expect(await createFrozenResidentPrompt().assemble(ctxB)).toContain(
		"B's fact",
	);
	for (const stop of a.recorded.handlers.get("session_shutdown") ?? []) {
		await withSession("a", () => stop({}, {}));
	}
	await installed.host.close("a", "shutdown");
	expect(closedA).toHaveBeenCalledTimes(1);
	expect(closedB).not.toHaveBeenCalled();
	const fresh = await createFrozenResidentPrompt().assemble(ctxB);
	expect(fresh).toContain("B's fact");
	expect(fresh).not.toContain("A's fact");
});
