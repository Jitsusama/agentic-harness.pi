import { describe, expect, it } from "vitest";
import { unreadNeeds } from "../../../lib/mesh/needs.ts";
import { unreadSaid } from "../../../lib/mesh/said-to.ts";
import { firstUnread } from "../../../lib/mesh/unread-lines.ts";

const NEED = JSON.stringify({
	name: "A1B2C3",
	title: "Disk sweep",
	asks: "May I?",
	since: "2026-11-24T14:00:00Z",
});

const SAID = JSON.stringify({
	address: "D4E5F6",
	at: "2026-11-24T14:10:00.000Z",
	text: "Carry on",
});

// An unread listing must never read as an empty one: "nothing waits" is
// said only of what was read.
describe("a listing in a shape this harness can't read", () => {
	it("is told from one that lists nothing", () => {
		expect(firstUnread("", () => false)).toBeUndefined();
		expect(firstUnread("\n  \n", () => false)).toBeUndefined();
		expect(firstUnread("odd\nodder", () => false)).toBe("odd");
		expect(firstUnread("odd\nfine", (line) => line === "fine")).toBeUndefined();
	});

	it("reads the cells' wants and what he said by their own shapes", () => {
		expect(unreadNeeds(NEED)).toBeUndefined();
		expect(unreadNeeds('{"cells":[]}')).toBe('{"cells":[]}');
		expect(unreadSaid(SAID)).toBeUndefined();
		expect(unreadSaid("[]")).toBe("[]");
	});
});
