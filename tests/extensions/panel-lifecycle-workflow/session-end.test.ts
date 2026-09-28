/**
 * A session's end closes every panel, whatever raised it.
 *
 * Pi emits `session_shutdown` for every way a session ends, `/reload`
 * included, before it disposes the session. Nothing else tells a panel
 * raised outside a turn that its session is gone.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../../extensions/panel-lifecycle-workflow/index.ts";
import { closeEveryPanel, trackPanel } from "../../../lib/ui/panel-registry.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function activate() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	panelLifecycle(pi as unknown as ExtensionAPI);
	return (name: string, event: unknown) => handlers.get(name)?.(event, {});
}

afterEach(() => closeEveryPanel());

describe("a session ending", () => {
	it.each([
		"quit",
		"reload",
		"new",
		"resume",
		"fork",
	])("closes every panel on %s", async (reason) => {
		const fire = activate();
		const stop = vi.fn();
		trackPanel(stop);

		await fire("session_shutdown", { type: "session_shutdown", reason });
		expect(stop).toHaveBeenCalledOnce();
	});
});
