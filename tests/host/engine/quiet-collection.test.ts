/**
 * The host's collection once it goes quiet: one last-resort collection a
 * quiet minute after the last turn or park, none while a conversation is
 * busy, and none again until something stirs. Fake timers stand in for
 * the minute; the last case runs V8's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	lastResortCollect,
	QUIET_MS,
	quietCollection,
} from "../../../host/engine/quiet-collection.ts";

describe("the host's collection once quiet", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function counted(busy = () => false) {
		const collect = vi.fn();
		const said: string[] = [];
		const quiet = quietCollection({
			busy,
			collect,
			report: (one) => said.push(one),
		});
		return { collect, said, quiet };
	}

	it("collects once a quiet minute after a turn, and says what it gave back", () => {
		const { collect, said, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said).toEqual([
			expect.stringMatching(
				/^Collected while quiet in \d+ ms, giving back -?\d+ MB$/,
			),
		]);
	});

	it("waits a whole minute again whenever something stirs", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS / 2);
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it("collects no more until something stirs again", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS * 10);
		expect(collect).toHaveBeenCalledTimes(1);
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS);
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it("leaves a busy conversation's turn alone, collecting after it ends", () => {
		let busy = true;
		const { collect, quiet } = counted(() => busy);
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS * 3);
		expect(collect).not.toHaveBeenCalled();
		busy = false;
		quiet.stirred();
		vi.advanceTimersByTime(QUIET_MS);
		expect(collect).toHaveBeenCalledTimes(1);
	});
});

describe("V8's last-resort collection", () => {
	it("runs in this process", () => {
		expect(() => lastResortCollect()()).not.toThrow();
	});
});
