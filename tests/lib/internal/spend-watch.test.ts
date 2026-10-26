import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../../lib/core/exec/index.ts";
import { askBill, isBillCut } from "../../../lib/internal/spend-watch.ts";

/** A report as spend-watch writes one, trimmed to two rows. */
const REPORT = {
	title: "Spend today by quest",
	period: "today",
	from: "2026-10-26",
	to: "2026-10-26",
	total: 2086.55,
	shown: "$2,087",
	source: "billed, the latest hours from the live meter",
	rows: [
		{
			name: "Bootstrap optimus",
			dollars: 1232.1,
			share: 0.59,
			shown: "$1,232",
			estimated: false,
		},
		{
			name: "no quest",
			dollars: 27.55,
			share: 0.01,
			shown: "$28",
			estimated: true,
		},
	],
	notes: ["579 more under $13,991 together."],
};

/** An Exec that answers every command alike and keeps what it was asked. */
function answering(result: ExecResult): Exec & { asked: string[][] } {
	const asked: string[][] = [];
	const exec = async (command: string, args: string[]) => {
		asked.push([command, ...args]);
		return result;
	};
	return Object.assign(exec, { asked });
}

describe("askBill", () => {
	it("asks spend-watch for the period and cut as JSON", async () => {
		const exec = answering({
			code: 0,
			stdout: JSON.stringify(REPORT),
			stderr: "",
		});
		await askBill(exec, "30 days", "session");
		expect(exec.asked).toEqual([
			["spend-watch", "report", "30 days", "by", "session", "--format", "json"],
		]);
	});

	it("asks for the whole period when there is no cut", async () => {
		const exec = answering({
			code: 0,
			stdout: JSON.stringify(REPORT),
			stderr: "",
		});
		await askBill(exec, "today");
		expect(exec.asked).toEqual([
			["spend-watch", "report", "today", "--format", "json"],
		]);
	});

	it("reads the total, which figure it is, the rows and the notes", async () => {
		const exec = answering({
			code: 0,
			stdout: JSON.stringify(REPORT),
			stderr: "",
		});
		expect(await askBill(exec, "today", "quest")).toEqual({
			title: "Spend today by quest",
			from: "2026-10-26",
			to: "2026-10-26",
			total: 2086.55,
			shown: "$2,087",
			source: "billed, the latest hours from the live meter",
			rows: [
				{
					name: "Bootstrap optimus",
					dollars: 1232.1,
					shown: "$1,232",
					estimated: false,
				},
				{ name: "no quest", dollars: 27.55, shown: "$28", estimated: true },
			],
			notes: ["579 more under $13,991 together."],
		});
	});

	it("is no bill when spend-watch isn't installed", async () => {
		const exec = answering({
			code: 1,
			stdout: "",
			stderr: "spawn spend-watch ENOENT",
		});
		expect(await askBill(exec, "today")).toBeUndefined();
	});

	it("is no bill when spend-watch ran out of time", async () => {
		const exec = answering({
			code: 124,
			stdout: "",
			stderr: "spend-watch timed out after 20000 ms",
		});
		expect(await askBill(exec, "today")).toBeUndefined();
	});

	it("is no bill when the answer isn't JSON", async () => {
		const exec = answering({
			code: 0,
			stdout: "Spend today\n$2,086",
			stderr: "",
		});
		expect(await askBill(exec, "today")).toBeUndefined();
	});

	it("is no bill when the JSON isn't a report", async () => {
		const exec = answering({
			code: 0,
			stdout: JSON.stringify({ ...REPORT, total: "lots" }),
			stderr: "",
		});
		expect(await askBill(exec, "today")).toBeUndefined();
	});

	it("drops a row that lacks an amount, keeping the rest", async () => {
		const rows = [{ name: "broken", shown: "$1" }, ...REPORT.rows];
		const exec = answering({
			code: 0,
			stdout: JSON.stringify({ ...REPORT, rows }),
			stderr: "",
		});
		const bill = await askBill(exec, "today", "quest");
		expect(bill?.rows.map((row) => row.name)).toEqual([
			"Bootstrap optimus",
			"no quest",
		]);
	});
});

describe("isBillCut", () => {
	it("accepts the groupings spend-watch cuts by and nothing else", () => {
		expect(["repo", "quest", "model", "day", "session"].every(isBillCut)).toBe(
			true,
		);
		expect(["document", "kind", "thinking"].some(isBillCut)).toBe(false);
	});
});
