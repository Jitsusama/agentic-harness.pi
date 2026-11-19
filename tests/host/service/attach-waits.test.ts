/**
 * What the journal says of a window's attach that waits, on a clock the
 * test drives: the whole attach's bound, each step after it, and how the
 * attach ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachWaits } from "../../../host/service/attach-waits.ts";

const BOUND_MS = 100;
const WHO = "00000001 (a0000000-0000-4000-8000-000000000001)";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("an attach's waits", () => {
	it("says the step it is on once quick steps add up past the bound", () => {
		const said: string[] = [];
		const waits = attachWaits(WHO, (line) => said.push(line), BOUND_MS);
		waits.next("the host's start to resume it");
		vi.advanceTimersByTime(40);
		waits.next("its open to finish");
		vi.advanceTimersByTime(40);
		waits.next("its park to settle");
		expect(said, "no step alone has passed the bound").toEqual([]);
		vi.advanceTimersByTime(20);
		expect(said).toEqual([
			`${WHO}: a window's attach has waited 0.1 s, now on its park to settle`,
		]);
	});

	it("once slow, says each later step that itself passes the bound, and not one that gives way at once", () => {
		const said: string[] = [];
		const waits = attachWaits(WHO, (line) => said.push(line), BOUND_MS);
		waits.next("the host's start to resume it");
		vi.advanceTimersByTime(BOUND_MS);
		waits.next("its open to finish");
		waits.next("its park to settle");
		vi.advanceTimersByTime(BOUND_MS - 1);
		expect(said, "the quick open, and the park so far, say nothing").toHaveLength(
			1,
		);
		vi.advanceTimersByTime(1);
		expect(said[1]).toBe(
			`${WHO}: a window's attach has waited 0.2 s, now on its park to settle`,
		);
		waits.answered();
		expect(said[2]).toBe(`${WHO}: a window's attach was answered after 0.2 s`);
		vi.advanceTimersByTime(BOUND_MS * 10);
		expect(said, "and nothing once it has ended").toHaveLength(3);
	});

	it("says nothing of an attach that ended inside its bound, answered or refused", () => {
		const said: string[] = [];
		const answered = attachWaits(WHO, (line) => said.push(line), BOUND_MS);
		answered.next("its open to finish");
		answered.answered();
		const refused = attachWaits(WHO, (line) => said.push(line), BOUND_MS);
		refused.next("its open to finish");
		refused.refused(new Error("Conversation is not hosted"));
		vi.advanceTimersByTime(BOUND_MS * 10);
		expect(said).toEqual([]);
	});

	it("says a slow refusal is one, even with no reason, and keeps its reason to one plain line", () => {
		const said: string[] = [];
		const bare = attachWaits(WHO, (line) => said.push(line), BOUND_MS);
		bare.next("its open to finish");
		vi.advanceTimersByTime(BOUND_MS);
		bare.refused(undefined);
		const escaped = attachWaits(WHO, (line) => said.push(line), BOUND_MS);
		escaped.next("its open to finish");
		vi.advanceTimersByTime(BOUND_MS);
		escaped.refused(new Error("not\n hosted\u001b[2J here"));
		expect(said[1], "a rejection with no reason is not an answer").toBe(
			`${WHO}: a window's attach was refused after 0.1 s: no reason given`,
		);
		expect(said[3], "no line breaks or escapes reach the journal").toBe(
			`${WHO}: a window's attach was refused after 0.1 s: not hosted[2J here`,
		);
	});
});
