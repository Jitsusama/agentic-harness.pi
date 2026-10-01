import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	answerCompactionStatus,
	askCompactionStatus,
	compactionsOn,
} from "../../../lib/compaction/index.ts";

describe("asking how compaction stands", () => {
	it("gathers each listener's section, in order", () => {
		const bus = createEventBus();
		answerCompactionStatus(bus, () => ({
			id: "later",
			title: "Later",
			order: 20,
			lines: ["b"],
		}));
		answerCompactionStatus(bus, (branch) => ({
			id: "first",
			title: "First",
			order: 10,
			lines: [`entries: ${branch.length}`],
		}));

		const sections = askCompactionStatus(bus, [{}, {}]);

		expect(sections.map((s) => [s.id, s.lines])).toEqual([
			["first", ["entries: 2"]],
			["later", ["b"]],
		]);
	});

	it("leaves out a listener with nothing to say", () => {
		const bus = createEventBus();
		answerCompactionStatus(bus, () => undefined);

		expect(askCompactionStatus(bus, [])).toEqual([]);
	});

	it("answers nobody when nothing is listening", () => {
		expect(askCompactionStatus(createEventBus(), [])).toEqual([]);
	});
});

describe("the compactions on a branch", () => {
	it("reads only compaction entries, with their records", () => {
		const branch = [
			{ type: "message", message: {} },
			{
				type: "compaction",
				summary: "first",
				tokensBefore: 240_000,
				timestamp: "2026-10-01T10:00:00Z",
				details: { summariser: "conversation" },
			},
			{ type: "custom", customType: "compaction-selection-tags" },
			{ type: "compaction", summary: "second" },
		];

		expect(compactionsOn(branch)).toEqual([
			{
				summary: "first",
				tokensBefore: 240_000,
				timestamp: "2026-10-01T10:00:00Z",
				details: { summariser: "conversation" },
			},
			{
				summary: "second",
				tokensBefore: undefined,
				timestamp: undefined,
				details: {},
			},
		]);
	});
});
