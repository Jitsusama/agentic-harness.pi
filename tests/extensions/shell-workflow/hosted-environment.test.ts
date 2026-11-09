/** Shell offers are session-scoped even when extensions reuse an offer name. */
import { afterEach, expect, it } from "vitest";
import {
	NoSessionInHost,
	withSession,
} from "../../../lib/core/session/index.ts";
import {
	offeredShellEnvironment,
	offerShellEnvironment,
} from "../../../lib/internal/shell/environment.ts";
import { installTestHost } from "../../support/session-host.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

it("keeps each shell's offers after another conversation withdraws and closes", async () => {
	const installed = installTestHost();
	dispose = installed.dispose;
	withSession("a", () =>
		offerShellEnvironment("quest", () => ({ SCRATCH: "a" })),
	);
	offerShellEnvironment("quest", () => ({ SCRATCH: "b" }), "b");
	expect(withSession("a", () => offeredShellEnvironment())).toEqual({
		SCRATCH: "a",
	});
	expect(withSession("b", () => offeredShellEnvironment())).toEqual({
		SCRATCH: "b",
	});
	offerShellEnvironment("quest", undefined, "a");
	expect(offeredShellEnvironment("a")).toEqual({});
	await installed.host.close("a", "done");
	expect(offeredShellEnvironment("b")).toEqual({ SCRATCH: "b" });
	expect(() => offeredShellEnvironment()).toThrow(NoSessionInHost);
});

it("merges current offers in order and skips a broken offer only in its session", () => {
	const installed = installTestHost();
	dispose = installed.dispose;
	let scratch = "first";
	offerShellEnvironment("quest", () => ({ SCRATCH: scratch }), "b");
	offerShellEnvironment(
		"broken",
		() => {
			throw new Error("broken offer");
		},
		"b",
	);
	offerShellEnvironment("later", () => ({ LATER: "yes" }), "b");
	expect(offeredShellEnvironment("b")).toEqual({
		SCRATCH: "first",
		LATER: "yes",
	});
	scratch = "next";
	expect(offeredShellEnvironment("b")).toEqual({
		SCRATCH: "next",
		LATER: "yes",
	});
	expect(offeredShellEnvironment("a")).toEqual({});
});
