import { describe, expect, it } from "vitest";
import {
	SUMMARY_CEILING_TOKENS,
	summaryCeiling,
} from "../../../extensions/compaction-workflow/ceiling.ts";

const ODD = "01a1b8be-44ff-77aa-be03-5ca923cefb7f";
const EVEN = "01a1b8be-44ff-77aa-be03-5ca923cefb70";

describe("summaryCeiling", () => {
	it("holds half the sessions to the ceiling, by the last digit of their id", () => {
		expect([
			summaryCeiling(ODD, undefined),
			summaryCeiling(EVEN, undefined),
		]).toEqual([SUMMARY_CEILING_TOKENS, undefined]);
	});

	it("gives every session the same answer each time", () => {
		expect([
			summaryCeiling(ODD, "trial"),
			summaryCeiling(ODD, "trial"),
		]).toEqual([SUMMARY_CEILING_TOKENS, SUMMARY_CEILING_TOKENS]);
	});

	it("holds no session to it when the setting is off", () => {
		expect([summaryCeiling(ODD, "off"), summaryCeiling(EVEN, "off")]).toEqual([
			undefined,
			undefined,
		]);
	});

	it("holds every session to a ceiling the setting names", () => {
		expect([summaryCeiling(ODD, "9000"), summaryCeiling(EVEN, "9000")]).toEqual(
			[9_000, 9_000],
		);
	});

	it("runs the trial when the setting names no size it can use", () => {
		expect([summaryCeiling(ODD, "-3"), summaryCeiling(EVEN, "lots")]).toEqual([
			SUMMARY_CEILING_TOKENS,
			undefined,
		]);
	});

	it("leaves a session with no id uncapped", () => {
		expect(summaryCeiling("", undefined)).toBeUndefined();
	});
});
