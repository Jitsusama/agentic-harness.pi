/**
 * The record each arrival leaves in its quest's scratch, since a held
 * start's output ends with its hold.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ArrivalRecord,
	arrivalRecordOf,
	recordArrival,
} from "../../../../lib/internal/carry/arrival-record.ts";
import { folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const SESSION = "01a19111-arrived";

function read(scratch: string): ArrivalRecord {
	return JSON.parse(readFileSync(arrivalRecordOf(scratch, SESSION), "utf8"));
}

describe("an arrival's record", () => {
	it("keeps every line an arrival said, and whether it came whole", () => {
		const scratch = folder(made, "scratch");
		const record: ArrivalRecord = {
			at: "2026-11-23T21:30:00.000Z",
			from: join(scratch, "handover", "optimus"),
			whole: false,
			said: [
				{
					kind: "tree",
					path: "/home/arrived/src/app",
					branch: "topic",
					did: "refused",
					why: "git couldn't clone it.",
				},
			],
		};

		recordArrival(scratch, SESSION, record);

		expect(arrivalRecordOf(scratch, SESSION)).toBe(
			join(scratch, "arrivals", `${SESSION}.json`),
		);
		expect(read(scratch)).toEqual(record);
	});

	it("writes a later arrival of the same session over the one before", () => {
		const scratch = folder(made, "scratch");
		const first: ArrivalRecord = {
			at: "2026-11-23T21:30:00.000Z",
			from: "optimus",
			whole: false,
			said: [],
		};
		const again: ArrivalRecord = { ...first, at: "later", whole: true };

		recordArrival(scratch, SESSION, first);
		recordArrival(scratch, SESSION, again);

		expect(read(scratch)).toEqual(again);
	});
});
