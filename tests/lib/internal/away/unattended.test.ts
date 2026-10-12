import { beforeEach, describe, expect, it } from "vitest";
import {
	goAway,
	heldCalls,
	resetAway,
} from "../../../../lib/internal/away/state.ts";
import {
	signInFailure,
	unattended,
} from "../../../../lib/internal/away/unattended.ts";

beforeEach(() => {
	resetAway();
});

/** A context that reads through getters, as pi's does. */
function context() {
	let reads = 0;
	return {
		get hasUI() {
			return true;
		},
		get cwd() {
			reads += 1;
			return `/work/${reads}`;
		},
	};
}

describe("a context handed to something that might prompt", () => {
	it("is the one given while the person is here", () => {
		const ctx = context();

		expect(unattended(ctx)).toBe(ctx);
	});

	it("says nobody can be asked while they are away", () => {
		goAway();

		expect(unattended(context()).hasUI).toBe(false);
	});

	it("still reads everything else live", () => {
		goAway();
		const ctx = unattended(context());

		expect(ctx.cwd).toBe("/work/1");
		expect(ctx.cwd).toBe("/work/2");
	});
});

describe("a sign-in that failed", () => {
	it("is the error as it was while the person is here", () => {
		const cause = new Error("expired");

		expect(signInFailure("Slack", "slack", cause)).toBe(cause);
		expect(heldCalls()).toEqual([]);
	});

	it("is held once for their return however often it fails", () => {
		goAway();

		const first = signInFailure("Slack", "slack", new Error("no UI"));
		signInFailure("Slack", "slack", new Error("token revoked"));

		expect(String(first)).toContain("held as #1");
		expect(String(first)).toContain("no UI");
		expect(heldCalls().map((h) => h.title)).toEqual(["Sign in to Slack"]);
	});
});
