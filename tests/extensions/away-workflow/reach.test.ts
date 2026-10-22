import { describe, expect, it } from "vitest";
import {
	blockedLine,
	blockedNotice,
	freshReach,
	heldNotice,
	MOST_SAID,
	stopNotice,
} from "../../../extensions/away-workflow/reach.ts";

describe("blockedLine", () => {
	it("reads what the last line says it is blocked on", () => {
		expect(blockedLine("Did things.\n\n**Blocked: the OTP.**")).toBe(
			"the OTP.",
		);
		expect(blockedLine("- blocked: a decision")).toBe("a decision");
	});

	it("is nothing for a run that did not end blocked", () => {
		expect(blockedLine("Blocked: early\nDone: all of it")).toBeUndefined();
	});
});

describe("reaching the absent person", () => {
	it("says held calls once an absence, and again in the next absence", () => {
		const memory = freshReach();
		expect(heldNotice("PLAN-1", "a", 0, memory)).toBeUndefined();
		expect(heldNotice("PLAN-1", "a", 1, memory)?.urgency).toBe("normal");
		expect(heldNotice("PLAN-1", "a", 2, memory)).toBeUndefined();
		expect(heldNotice("PLAN-1", "b", 1, memory)).toBeDefined();
	});

	it("says each thing a run is blocked on once, and a new thing again", () => {
		const memory = freshReach();
		expect(blockedNotice("q", "a", "Blocked: x", memory)?.body).toBe("x");
		expect(blockedNotice("q", "a", "Blocked: x", memory)).toBeUndefined();
		expect(blockedNotice("q", "a", "Blocked: y", memory)?.body).toBe("y");
		expect(blockedNotice("q", "a", "All good.", memory)).toBeUndefined();
	});

	it("still says something when Blocked names nothing", () => {
		const notice = blockedNotice("q", "a", "Blocked:", freshReach());
		expect(notice?.body).toBe("Everything left needs you.");
	});

	it("keeps a long Blocked line to one notification's worth", () => {
		const long = `Blocked: ${"word ".repeat(100)}`;
		const body = blockedNotice("q", "a", long, freshReach())?.body ?? "";
		expect(body.length).toBe(MOST_SAID);
		expect(body.endsWith("…")).toBe(true);
	});

	it("says a rest once an absence, quietly", () => {
		const memory = freshReach();
		expect(stopNotice("q", "a", "stopped", memory)?.urgency).toBe("low");
		expect(stopNotice("q", "a", "stopped", memory)).toBeUndefined();
	});
});
