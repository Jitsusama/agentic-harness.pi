/**
 * Carried work of a kind job-workflow doesn't run is handed, on the bus,
 * to the extension that answers for that kind.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	offerCarried,
	type Taking,
	takesUpCarried,
} from "../../../lib/jobs/take-up.ts";

const disposers: (() => void)[] = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

const taking = (name: string): Taking => ({
	start: () => {
		throw new Error(`${name} is only offered here, never started`);
	},
});

describe("offering carried work", () => {
	it("finds the extension that answers for its kind", () => {
		const bus = createEventBus();
		const checks = taking("checks");
		disposers.push(
			takesUpCarried(bus, "review-round", () => taking("round")),
			takesUpCarried(bus, "review-checks", () => checks),
		);
		expect(offerCarried(bus, { kind: "review-checks" })).toBe(checks);
	});

	it("hands the work to the one that reads it", () => {
		const bus = createEventBus();
		const read: unknown[] = [];
		disposers.push(
			takesUpCarried(bus, "review-checks", (work) => {
				read.push(work);
				return taking("checks");
			}),
		);
		offerCarried(bus, { kind: "review-checks", key: "gh:shop/app#7" });
		expect(read).toEqual([{ kind: "review-checks", key: "gh:shop/app#7" }]);
	});

	it("finds nobody when no extension answers for the kind", () => {
		const bus = createEventBus();
		disposers.push(takesUpCarried(bus, "review-round", () => taking("round")));
		expect(offerCarried(bus, { kind: "fleet" })).toBeUndefined();
	});

	it("finds nobody when the one for its kind can't read it", () => {
		const bus = createEventBus();
		disposers.push(takesUpCarried(bus, "review-checks", () => undefined));
		expect(offerCarried(bus, { kind: "review-checks" })).toBeUndefined();
	});

	it("stops answering once disposed", () => {
		const bus = createEventBus();
		takesUpCarried(bus, "review-checks", () => taking("checks"))();
		expect(offerCarried(bus, { kind: "review-checks" })).toBeUndefined();
	});
});
