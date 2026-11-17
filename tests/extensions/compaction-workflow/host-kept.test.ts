/**
 * The host keeping the session's last request across a reload or a
 * restart of the same session, never into another, and forgetting it
 * once the session compacts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestHost } from "../../support/session-host.ts";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

const { activate, compactEvent, context, fellBack, HANDOFF, model, replyEntry, sentPayload, userEntry } = await import(
	"./host-fixtures.ts"
);

describe("the conversation summariser", () => {
	beforeEach(() => {
		completeSimple.mockReset();
	});
	it("keeps the last request across a reload of the same session", async () => {
		const before = activate();
		const ctx = context([userEntry, replyEntry]);
		await before.fire("before_provider_request", { payload: sentPayload }, ctx);
		await before.fire("session_shutdown", { reason: "reload" }, ctx);

		const after = activate();
		await after.fire("session_start", { reason: "reload" }, ctx);
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const result = await after.fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		);

		expect(after.entries).toEqual([]);
		expect(result).toHaveProperty("compaction");
	});

	it("does not carry a request across a reload into another session", async () => {
		const before = activate();
		const ctx = context([userEntry, replyEntry]);
		await before.fire("before_provider_request", { payload: sentPayload }, ctx);
		await before.fire("session_shutdown", { reason: "reload" }, ctx);

		const after = activate();
		const other = {
			...ctx,
			sessionManager: { ...ctx.sessionManager, getSessionId: () => "s2" },
		};
		await after.fire("session_start", { reason: "reload" }, other);
		await after.fire("session_before_compact", compactEvent(), other);

		expect(after.entries).toEqual([
			fellBack("declined", "nothing has been sent this session"),
		]);
	});

	it("takes the request the code before it left across a reload", async () => {
		const ctx = context([userEntry, replyEntry]);
		const sent = {
			payload: sentPayload,
			leafId: "u1",
			modelId: model.id,
			at: Date.now(),
		};
		(globalThis as Record<symbol, unknown>)[Symbol.for(HANDOFF)] = {
			held: { sessionId: "s1", sent },
		};

		const after = activate();
		await after.fire("session_start", { reason: "reload" }, ctx);
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const result = await after.fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		);

		expect(result, "the old record, read as before").toHaveProperty(
			"compaction",
		);
	});

	describe("on a host", () => {
		let dispose: (() => void) | undefined;
		afterEach(() => {
			dispose?.();
			dispose = undefined;
		});

		/** Conversation `id`'s context, on the same branch as the others. */
		const conversation = (id: string) => {
			const ctx = context([userEntry, replyEntry]);
			return {
				...ctx,
				sessionManager: { ...ctx.sessionManager, getSessionId: () => id },
			};
		};

		it("keeps each conversation's request across reloads at once, and B's past A's close", async () => {
			const installed = installTestHost();
			dispose = installed.dispose;
			const [a, b] = [conversation("a"), conversation("b")];
			const [beforeA, beforeB] = [activate(), activate()];
			await beforeA.fire(
				"before_provider_request",
				{ payload: sentPayload },
				a,
			);
			await beforeB.fire(
				"before_provider_request",
				{ payload: sentPayload },
				b,
			);
			await beforeA.fire("session_shutdown", { reason: "reload" }, a);
			await beforeB.fire("session_shutdown", { reason: "reload" }, b);

			const afterA = activate();
			await afterA.fire("session_start", { reason: "reload" }, a);
			await installed.host.close("a", "done");
			const afterB = activate();
			await afterB.fire("session_start", { reason: "reload" }, b);
			completeSimple.mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "## Goal" }],
				usage: {},
			});
			const wroteA = await afterA.fire(
				"session_before_compact",
				compactEvent(),
				a,
			);
			const wroteB = await afterB.fire(
				"session_before_compact",
				compactEvent(),
				b,
			);

			expect(wroteA, "A took its own, not B's").toHaveProperty("compaction");
			expect(wroteB, "B's outlived A's reload and close").toHaveProperty(
				"compaction",
			);
			expect(
				(globalThis as Record<symbol, unknown>)[Symbol.for(HANDOFF)],
				"nothing of either left where plain pi keeps it",
			).toBeUndefined();
		});
	});

	it("forgets the sent request once the session compacts", async () => {
		const { fire, entries } = activate();
		const ctx = context([userEntry, replyEntry]);
		await fire("before_provider_request", { payload: sentPayload }, ctx);
		await fire("session_compact", {}, ctx);
		await fire("session_before_compact", compactEvent(), ctx);
		expect(entries[0]?.[1]).toMatchObject({
			reason: "nothing has been sent this session",
		});
	});

	it("keeps the last request across a restart of the same session", async () => {
		const before = activate();
		const ctx = context([userEntry, replyEntry]);
		await before.fire("before_provider_request", { payload: sentPayload }, ctx);
		await before.fire("session_shutdown", { reason: "quit" }, ctx);

		const after = activate();
		await after.fire("session_start", { reason: "resume" }, ctx);
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## Goal" }],
			usage: {},
		});
		const result = await after.fire(
			"session_before_compact",
			compactEvent(),
			ctx,
		);
		expect(result).toHaveProperty("compaction");

		// Taken once: a second start of the session finds nothing kept.
		const again = activate();
		await again.fire("session_start", { reason: "resume" }, ctx);
		await again.fire("session_before_compact", compactEvent(), ctx);
		expect(again.entries[0]?.[1]).toMatchObject({
			reason: "nothing has been sent this session",
		});
	});
});
