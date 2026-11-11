/** A conversation an extension ends says who asked, in a host's journal. */
import { afterEach, expect, it, vi } from "vitest";
import {
	type Host,
	installHost,
	type SessionEnvironment,
} from "../../../lib/core/session/index.ts";
import { endConversation } from "../../../lib/core/session/owner.ts";

const SESSION = "a0000000-0000-4000-8000-000000000001";

let uninstall: (() => void) | undefined;
afterEach(() => {
	uninstall?.();
	uninstall = undefined;
	vi.restoreAllMocks();
});

function emptyEnv(): SessionEnvironment {
	return {
		get: () => undefined,
		set() {},
		delete() {},
		snapshot: () => ({}),
	};
}

/** A host whose close does as `close` says, and the closes it was asked for. */
function installed(close: () => Promise<void> = async () => {}): string[] {
	const asked: string[] = [];
	const host: Host = {
		kind: "pi-durable",
		key: "test-host",
		owner: { pid: process.pid, startedAt: 1, startTicks: 7 },
		holds: () => "idle",
		env: emptyEnv,
		hints: () => ({}),
		close: (id, why) => {
			asked.push(`${id}: ${why}`);
			return close();
		},
		stamp() {},
	};
	uninstall = installHost(host);
	return asked;
}

function context() {
	const shutdown = vi.fn<() => void>();
	return {
		shutdown,
		ctx: { shutdown, sessionManager: { getSessionId: () => SESSION } },
	};
}

it("closes a hosted conversation through its host, saying who asked, rather than pi's shutdown", async () => {
	const asked = installed();
	const { ctx, shutdown } = context();

	endConversation(ctx, "quest-workflow, its quest QEST-1 being concluded");

	await vi.waitFor(() =>
		expect(asked, "the host's close names who asked").toEqual([
			`${SESSION}: closed, asked by quest-workflow, its quest QEST-1 being concluded`,
		]),
	);
	expect(shutdown, "pi's shutdown says no reason").not.toHaveBeenCalled();
});

it("shuts plain pi down as it always has", () => {
	const { ctx, shutdown } = context();

	endConversation(ctx, "anyone");

	expect(
		shutdown,
		"plain pi ends through its own shutdown",
	).toHaveBeenCalledTimes(1);
});

it("says on the host's standard error when its close failed", async () => {
	installed(async () => {
		throw new Error("the engine is gone");
	});
	const wrote = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const { ctx } = context();

	endConversation(ctx, "a carry to penelope");

	await vi.waitFor(() =>
		expect(String(wrote.mock.calls.at(0)?.at(0)), "the failure is said").toBe(
			`pi-host: ${SESSION} didn't close, asked by a carry to penelope: the engine is gone\n`,
		),
	);
});
