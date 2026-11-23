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

	it("gives a notice said before anyone listens to the first listener only, once", () => {
		sayKeyringNotice({ level: "warning", message: "early" });
		sayKeyringNotice({ level: "warning", message: "early" });
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "first"), {});
		onKeyringNotice(hearing(heard, "second"), {});
		expect(heard).toEqual(["first: early"]);
	});

	it("shows the same words on a screen once, and on a screen that opens later when said again", () => {
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "first"), {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		sayKeyringNotice({ level: "warning", message: "locked" });
		onKeyringNotice(hearing(heard, "later"), {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		expect(heard).toEqual(["first: locked", "later: locked"]);
	});

	it("keeps a notice every listener threw on for the next listener to come", () => {
		const stale = () => {
			throw new Error("a screen gone stale");
		};
		onKeyringNotice(stale, {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "next"), {});
		expect(heard).toEqual(["next: locked"]);
	});

	it("keeps what was waiting past a first listener that throws on it, and lets that listener stop", () => {
		sayKeyringNotice({ level: "warning", message: "early" });
		sayKeyringNotice({ level: "info", message: "moved" });
		let stop: (() => void) | undefined;
		expect(() => {
			stop = onKeyringNotice(() => {
				throw new Error("a screen gone stale");
			}, {});
		}).not.toThrow();
		stop?.();
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "next"), {});
		sayKeyringNotice({ level: "info", message: "later" });
		expect(heard).toEqual(["next: early", "next: moved", "next: later"]);
	});
});
