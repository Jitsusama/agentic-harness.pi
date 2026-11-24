/**
 * Why a call can't be asked about is said once in a session, at the end
 * of a turn, and only to a session with a screen to say it on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sayCallUnasked } from "../../../extensions/priority-workflow/index.ts";
import type { CallTrouble } from "../../../lib/internal/calls/probe.ts";
import { endTurn } from "../../support/turn-end.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const refused: CallTrouble = {
	kind: "refused",
	why: "a-call-is-on doesn't take --here",
};

let handlers: Map<string, Handler[]>;
let heard: (trouble: CallTrouble) => void;

const fire = async (name: string, event: unknown, ctx: unknown) => {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};

/** A context with a screen or without, and what was said on it. */
function context(hasUI: boolean) {
	const notify = vi.fn();
	return { ctx: { hasUI, ui: { notify } }, notify };
}

beforeEach(() => {
	handlers = new Map();
	const pi = {
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	} as unknown as ExtensionAPI;
	heard = sayCallUnasked(pi);
});

describe("saying a call can't be asked about", () => {
	it("says it once, at the end of the turn after it was heard", async () => {
		const { ctx, notify } = context(true);

		const saidBy: number[] = [];
		await endTurn(fire, {}, ctx);
		saidBy.push(notify.mock.calls.length);
		heard(refused);
		saidBy.push(notify.mock.calls.length);
		await endTurn(fire, {}, ctx);
		saidBy.push(notify.mock.calls.length);
		heard(refused);
		await endTurn(fire, {}, ctx);
		saidBy.push(notify.mock.calls.length);

		expect(saidBy, "said counts after each step").toEqual([0, 0, 1, 1]);
		expect(notify.mock.calls).toEqual([
			[
				"a-call-is-on doesn't take --here, so heavy work starts even while you're on a call.",
				"warning",
			],
		]);
	});

	it("says nothing in a session without a screen", async () => {
		const { ctx, notify } = context(false);

		heard(refused);
		await endTurn(fire, {}, ctx);

		expect(notify).not.toHaveBeenCalled();
	});

	it("says nothing of a machine without a-call-is-on", async () => {
		const { ctx, notify } = context(true);

		heard({ kind: "missing", why: "a-call-is-on isn't on the PATH" });
		await endTurn(fire, {}, ctx);

		expect(notify).not.toHaveBeenCalled();
	});
});
