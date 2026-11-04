/**
 * The widget's wiring: it wraps pi's fullscreen press while a session
 * runs, once however often a session starts, and takes it off when the
 * session ends.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import linkClickWidget from "../../../extensions/link-click-widget/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function loaded() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	linkClickWidget(pi as unknown as ExtensionAPI);
	const fire = async (name: string) =>
		handlers.get(name)?.({ type: name }, { cwd: process.cwd(), hasUI: true });
	return { fire };
}

const press = () =>
	Reflect.get(TuiAltScreen.prototype, "handleSelectionMouseEvent");

describe("the link click widget", () => {
	it("wraps pi's press for a session's life, once", async () => {
		const pis = press();
		const { fire } = loaded();
		await fire("session_start");
		const wrapped = press();
		expect(wrapped).not.toBe(pis);
		await fire("session_start");
		expect(press()).toBe(wrapped);
		await fire("session_shutdown");
		expect(press()).toBe(pis);
	});

	it("leaves a newer copy's wrap on when an older copy ends", async () => {
		const pis = press();
		const older = loaded();
		const newer = loaded();
		await older.fire("session_start");
		await newer.fire("session_start");
		await older.fire("session_shutdown");
		expect(press()).not.toBe(pis);
		await newer.fire("session_shutdown");
		expect(press()).toBe(pis);
	});
});
