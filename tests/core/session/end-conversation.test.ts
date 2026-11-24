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

it("tells a host's failed close to whoever asked, once it has failed", async () => {
	installed(async () => {
		throw new Error("the engine is gone");
	});
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const { ctx } = context();
	const failed = vi.fn<(error: unknown) => void>();

	endConversation(ctx, "a carry to penelope", failed);

	expect(failed, "not before the close is tried").not.toHaveBeenCalled();
	await vi.waitFor(() =>
		expect(failed).toHaveBeenCalledWith(new Error("the engine is gone")),
	);
});

it("says on the host's standard error when telling a failed close throws, rather than leaving a rejection unhandled", async () => {
	installed(async () => {
		throw new Error("the engine is gone");
	});
	const wrote = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	const { ctx } = context();

	try {
		endConversation(ctx, "a carry to penelope", () => {
			throw new Error("its screen is gone");
		});

		await vi.waitFor(() =>
			expect(String(wrote.mock.calls.at(1)?.at(0))).toBe(
				`pi-host: ${SESSION}'s failed close couldn't be told: its screen is gone\n`,
			),
		);
		expect(unhandled).not.toHaveBeenCalled();
	} finally {
		process.off("unhandledRejection", unhandled);
	}
});

it("tells plain pi's failed shutdown to whoever asked, rather than throwing", () => {
	const { ctx, shutdown } = context();
	shutdown.mockImplementation(() => {
		throw new Error("the session is stale");
	});
	const failed = vi.fn<(error: unknown) => void>();

	endConversation(ctx, "a carry to penelope", failed);

	expect(failed).toHaveBeenCalledWith(new Error("the session is stale"));
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

it("tells a host's close that landed to whoever asked, and never as failed", async () => {
	installed();
	const { ctx } = context();
	const failed = vi.fn<(error: unknown) => void>();
	const closed = vi.fn<() => void>();

	endConversation(ctx, "a carry to penelope", failed, closed);

	await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
	expect(failed, "a close that works is no failure").not.toHaveBeenCalled();
});

it("leaves no rejection unhandled where what a failed close threw can't be put in words", async () => {
	installed(async () => {
		// No prototype, so no toString: String() of it throws.
		throw Object.create(null);
	});
	const wrote = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	const { ctx } = context();
	const failed = vi.fn<(error: unknown) => void>();

	try {
		endConversation(ctx, "a carry to penelope", failed);

		await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
		expect(
			wrote.mock.calls.map((call) => String(call[0])),
			"the failure is still said",
		).toContainEqual(
			expect.stringMatching(
				new RegExp(
					`^pi-host: ${SESSION} didn't close, asked by a carry to penelope: \\S`,
				),
			),
		);
		// A rejection is reported on a later turn of the loop.
		await new Promise((done) => setTimeout(done, 20));
		expect(unhandled).not.toHaveBeenCalled();
	} finally {
		process.off("unhandledRejection", unhandled);
	}
});
