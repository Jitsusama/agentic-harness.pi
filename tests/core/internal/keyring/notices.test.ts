import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	onKeyringNotice,
	resetKeyringNotices,
	sayKeyringNotice,
} from "../../../../lib/core/internal/keyring/notices.ts";

/** A listener that keeps what it hears in `heard`, under `name`. */
function hearing(heard: string[], name: string) {
	return (notice: { message: string }) => {
		heard.push(`${name}: ${notice.message}`);
	};
}

describe("keyring notices", () => {
	beforeEach(() => {
		resetKeyringNotices();
	});

	afterEach(() => {
		resetKeyringNotices();
	});

	it("reaches each screen once, however its listeners interleave", () => {
		const heard: string[] = [];
		const left = {};
		const right = {};
		onKeyringNotice(hearing(heard, "left one"), left);
		onKeyringNotice(hearing(heard, "right one"), right);
		onKeyringNotice(hearing(heard, "left two"), left);
		onKeyringNotice(hearing(heard, "right two"), right);
		sayKeyringNotice({ level: "warning", message: "locked" });
		expect(heard).toEqual(["left one: locked", "right one: locked"]);
	});

	it("counts a listener naming no screen as a screen of its own", () => {
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "first"));
		onKeyringNotice(hearing(heard, "second"));
		sayKeyringNotice({ level: "info", message: "moved" });
		expect(heard).toEqual(["first: moved", "second: moved"]);
	});

	it("still reaches a screen, and every other, past a listener that throws", () => {
		const heard: string[] = [];
		const shared = {};
		const other = {};
		onKeyringNotice(() => {
			throw new Error("a screen gone stale");
		}, shared);
		onKeyringNotice(hearing(heard, "shared"), shared);
		onKeyringNotice(hearing(heard, "other"), other);
		expect(() =>
			sayKeyringNotice({ level: "warning", message: "locked" }),
		).not.toThrow();
		expect(heard).toEqual(["shared: locked", "other: locked"]);
	});

	it("gives a notice said before anyone listens to the first listener only", () => {
		sayKeyringNotice({ level: "warning", message: "early" });
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "first"), {});
		onKeyringNotice(hearing(heard, "second"), {});
		expect(heard).toEqual(["first: early"]);
	});
});
