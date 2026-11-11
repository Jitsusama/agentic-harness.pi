/**
 * What a host reads of a conversation's screen before it restarts: the
 * gates docked on it and the gates holding or waiting for it, each that
 * conversation's alone, read without installing anything.
 */

import { afterEach, describe, expect, it } from "vitest";
import { withSession } from "../../../lib/core/session/index.ts";
import { runGate } from "../../../lib/ui/gate-queue.ts";
import {
	DOCK_NAME,
	gatesDocked,
	gatesWaiting,
	QUEUE_NAME,
} from "../../../lib/ui/screen-gates.ts";
import { keepOnScreen, screenValue } from "../../../lib/ui/screen-slot.ts";
import { installTestHost } from "../../support/session-host.ts";

let host: ReturnType<typeof installTestHost> | undefined;

afterEach(() => {
	host?.dispose();
	host = undefined;
});

/** Let every settled promise run its handlers. */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A gate that stays up until its `close` is called. */
function openGate(signal?: AbortSignal) {
	let close: () => void = () => {};
	const done = runGate(
		() =>
			new Promise<void>((resolve) => {
				close = resolve;
			}),
		{ signal },
	);
	return { done, close: () => close() };
}

describe("gatesWaiting", () => {
	it("counts the gate on screen and each in line, in that conversation only", async () => {
		host = installTestHost();
		const first = withSession("a", () => openGate());
		const second = withSession("a", () => openGate());
		await drain();
		expect(withSession("a", gatesWaiting)).toBe(2);
		expect(withSession("b", gatesWaiting)).toBe(0);

		first.close();
		await first.done;
		await drain();
		expect(withSession("a", gatesWaiting)).toBe(1);
		second.close();
		await second.done;
		expect(withSession("a", gatesWaiting)).toBe(0);
	});

	it("counts a gate stopped while it waits as gone", async () => {
		host = installTestHost();
		const up = withSession("a", () => openGate());
		const stopping = new AbortController();
		const queued = withSession("a", () => openGate(stopping.signal));
		stopping.abort();
		await expect(queued.done).rejects.toThrow();
		expect(withSession("a", gatesWaiting)).toBe(1);
		up.close();
		await up.done;
	});

	it("reads none from a screen with no queue, and installs none", () => {
		host = installTestHost();
		expect(withSession("a", gatesWaiting)).toBe(0);
		expect(withSession("a", () => screenValue(QUEUE_NAME))).toBeUndefined();
	});

	it("reads none from a queue an older copy installed", () => {
		host = installTestHost();
		withSession("a", () =>
			keepOnScreen(QUEUE_NAME, { version: 1, run: async () => undefined }),
		);
		expect(withSession("a", gatesWaiting)).toBe(0);
	});
});

describe("gatesDocked", () => {
	it("counts the docked gates, and no other widget", () => {
		host = installTestHost();
		withSession("a", () =>
			keepOnScreen(DOCK_NAME, {
				version: 1,
				entries: [{ gate: true }, { gate: false }, {}, { gate: true }],
				editor: undefined,
				swallow: undefined,
			}),
		);
		expect(withSession("a", gatesDocked)).toBe(2);
		expect(withSession("b", gatesDocked)).toBe(0);
	});

	it("reads none from a screen with no dock, and installs none", () => {
		host = installTestHost();
		expect(withSession("a", gatesDocked)).toBe(0);
		expect(withSession("a", () => screenValue(DOCK_NAME))).toBeUndefined();
	});
});
