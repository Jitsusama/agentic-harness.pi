import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	onKeyringNotice,
	resetKeyringNotices,
	retryKeyringNotices,
	sayKeyringNotice,
} from "../../../../lib/core/internal/keyring/notices.ts";

/** A listener that keeps what it hears in `heard`, under `name`. */
function hearing(heard: string[], name: string) {
	return (notice: { message: string }) => {
		heard.push(`${name}: ${notice.message}`);
		return true;
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
		let thrown = 0;
		expect(() => {
			stop = onKeyringNotice(() => {
				thrown++;
				throw new Error("a screen gone stale");
			}, {});
		}).not.toThrow();
		stop?.();
		const before = thrown;
		const heard: string[] = [];
		onKeyringNotice(hearing(heard, "next"), {});
		sayKeyringNotice({ level: "info", message: "later" });
		expect(heard).toEqual(["next: early", "next: moved", "next: later"]);
		expect(thrown).toBe(before);
	});

	it("keeps showing on a screen once one of its two listeners stops", () => {
		const heard: string[] = [];
		const shared = {};
		const stop = onKeyringNotice(hearing(heard, "first"), shared);
		onKeyringNotice(hearing(heard, "second"), shared);
		stop();
		sayKeyringNotice({ level: "info", message: "moved" });
		expect(heard).toEqual(["second: moved"]);
	});

	it("keeps a notice a listener declined waiting through each retry it declines, and shows it at the first it takes, once", () => {
		const heard: string[] = [];
		const unbound = { bound: false };
		onKeyringNotice(unboundUntil(unbound, heard, "late"), {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		retryKeyringNotices();
		retryKeyringNotices();
		expect(heard).toEqual([]);
		unbound.bound = true;
		retryKeyringNotices();
		expect(heard).toEqual(["late: locked"]);
		retryKeyringNotices();
		sayKeyringNotice({ level: "warning", message: "locked" });
		expect(heard).toEqual(["late: locked"]);
	});

	it("keeps a notice for a screen that declined it while another took it", () => {
		const heard: string[] = [];
		const unbound = { bound: false };
		onKeyringNotice(hearing(heard, "bound"), {});
		onKeyringNotice(unboundUntil(unbound, heard, "late"), {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		expect(heard).toEqual(["bound: locked"]);
		unbound.bound = true;
		retryKeyringNotices();
		retryKeyringNotices();
		expect(heard).toEqual(["bound: locked", "late: locked"]);
	});

	it("keeps what a screen is owed while it is between listeners, as across a reload", () => {
		const heard: string[] = [];
		const reloading = {};
		onKeyringNotice(hearing(heard, "taker"), {});
		const stop = onKeyringNotice(() => false, reloading);
		sayKeyringNotice({ level: "warning", message: "locked" });
		stop("back soon");
		onKeyringNotice(hearing(heard, "other"), {});
		retryKeyringNotices();
		onKeyringNotice(hearing(heard, "reloaded"), reloading);
		expect(heard).toEqual(["taker: locked", "reloaded: locked"]);
	});

	it("owes a notice said again to the screens owed it before as well as those lacking it now", () => {
		const heard: string[] = [];
		const reloading = {};
		onKeyringNotice(hearing(heard, "taker"), {});
		const stop = onKeyringNotice(() => false, reloading);
		sayKeyringNotice({ level: "warning", message: "locked" });
		stop("back soon");
		onKeyringNotice(() => false, {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		onKeyringNotice(hearing(heard, "reloaded"), reloading);
		expect(heard).toEqual(["taker: locked", "reloaded: locked"]);
	});

	it("forgets what a screen was owed once its last listener stops for good", () => {
		const heard: string[] = [];
		const ended = {};
		onKeyringNotice(hearing(heard, "taker"), {});
		const first = onKeyringNotice(() => false, ended);
		const second = onKeyringNotice(() => false, ended);
		sayKeyringNotice({ level: "warning", message: "locked" });
		first();
		second();
		onKeyringNotice(hearing(heard, "same screen"), ended);
		expect(heard).toEqual(["taker: locked"]);
	});

	it("keeps what a screen is owed while another of its listeners remains", () => {
		const heard: string[] = [];
		const session = {};
		onKeyringNotice(hearing(heard, "taker"), {});
		const first = onKeyringNotice(() => false, session);
		onKeyringNotice(() => false, session);
		sayKeyringNotice({ level: "warning", message: "locked" });
		first();
		onKeyringNotice(hearing(heard, "bound"), session);
		expect(heard).toEqual(["taker: locked", "bound: locked"]);
	});

	it("never replays to a later screen a notice another took, though one screen keeps declining it", () => {
		const heard: string[] = [];
		const never = { bound: false };
		onKeyringNotice(unboundUntil(never, heard, "headless"), {});
		onKeyringNotice(hearing(heard, "bound"), {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		onKeyringNotice(hearing(heard, "later"), {});
		retryKeyringNotices();
		expect(heard).toEqual(["bound: locked"]);
		sayKeyringNotice({ level: "warning", message: "locked" });
		expect(heard).toEqual(["bound: locked", "later: locked"]);
	});

	it("keeps a reloading screen's share of a notice said again while no screen takes it", () => {
		const heard: string[] = [];
		const reloading = {};
		const stopTaker = onKeyringNotice(hearing(heard, "taker"), {});
		const stop = onKeyringNotice(() => false, reloading);
		sayKeyringNotice({ level: "warning", message: "locked" });
		stop("back soon");
		stopTaker();
		sayKeyringNotice({ level: "warning", message: "locked" });
		onKeyringNotice(hearing(heard, "stranger"), {});
		onKeyringNotice(hearing(heard, "reloaded"), reloading);
		expect(heard).toEqual([
			"taker: locked",
			"stranger: locked",
			"reloaded: locked",
		]);
	});

	it("owes a screen between listeners a notice first said while it was away, though another took it", () => {
		const heard: string[] = [];
		const reloading = {};
		const stop = onKeyringNotice(hearing(heard, "before"), reloading);
		stop("back soon");
		onKeyringNotice(hearing(heard, "taker"), {});
		sayKeyringNotice({ level: "warning", message: "locked" });
		onKeyringNotice(hearing(heard, "reloaded"), reloading);
		expect(heard).toEqual(["taker: locked", "reloaded: locked"]);
	});

	it("keeps a notice for the other screens owed it when one of them is forgotten", () => {
		const heard: string[] = [];
		const ended = {};
		const waitingScreen = {};
		onKeyringNotice(hearing(heard, "taker"), {});
		const stopEnded = onKeyringNotice(() => false, ended);
		const stopWaiting = onKeyringNotice(() => false, waitingScreen);
		sayKeyringNotice({ level: "warning", message: "locked" });
		stopWaiting("back soon");
		stopEnded();
		onKeyringNotice(hearing(heard, "back"), waitingScreen);
		expect(heard).toEqual(["taker: locked", "back: locked"]);
	});

	it("holds a notice said many times to a screen that keeps declining once, so each retry offers it once", () => {
		let offered = 0;
		onKeyringNotice(() => {
			offered++;
			return false;
		}, {});
		for (let said = 0; said < 50; said++)
			sayKeyringNotice({ level: "warning", message: "locked" });
		const before = offered;
		retryKeyringNotices();
		expect(offered - before).toBe(1);
	});
});

/** A listener that declines until `unbound.bound`, then keeps what it hears in `heard`, under `name`. */
function unboundUntil(
	unbound: { bound: boolean },
	heard: string[],
	name: string,
) {
	return (notice: { message: string }) => {
		if (!unbound.bound) return false;
		heard.push(`${name}: ${notice.message}`);
		return true;
	};
}
