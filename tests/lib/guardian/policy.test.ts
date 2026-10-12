import { beforeEach, describe, expect, it } from "vitest";
import { refusalUnder } from "../../../lib/guardian/apply.ts";
import {
	declareGuard,
	guardMode,
	listGuards,
	parseGuardSection,
	restoreSessionModes,
	selectorKeys,
	setConfiguredModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	type GuardReport,
	isGuardReport,
	reportGuard,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";

beforeEach(() => {
	restoreSessionModes({});
	setConfiguredModes({});
	setGuardReportSink(undefined);
});

describe("resolving a guard's mode", () => {
	it("uses the guard's own default when nothing says otherwise", () => {
		declareGuard({
			name: "t-commit",
			class: "approval",
			description: "",
			defaultMode: "report",
		});

		expect(guardMode("t-commit")).toBe("report");
	});

	it("lets config beat the default and a session override beat config", () => {
		declareGuard({
			name: "t-pr",
			class: "approval",
			description: "",
			defaultMode: "report",
		});

		setConfiguredModes({ "t-pr": "block" });
		expect(guardMode("t-pr")).toBe("block");

		setSessionMode("t-pr", "off");
		expect(guardMode("t-pr")).toBe("off");
	});

	it("prefers the most specific key within a layer", () => {
		declareGuard({
			name: "t-history",
			class: "safety",
			description: "",
			defaultMode: "report",
			groups: ["t-git"],
		});

		setConfiguredModes({ all: "off", safety: "report", "t-git": "block" });
		expect(guardMode("t-history")).toBe("block");

		setConfiguredModes({ all: "off", safety: "report" });
		expect(guardMode("t-history")).toBe("report");

		setConfiguredModes({ all: "off" });
		expect(guardMode("t-history")).toBe("off");
	});

	it("lets a broad session override beat a narrow config setting", () => {
		// The session is what somebody asked for just now; config is what
		// they set up once. Now wins.
		declareGuard({
			name: "t-issue",
			class: "approval",
			description: "",
			defaultMode: "report",
		});
		setConfiguredModes({ "t-issue": "block" });
		setSessionMode("all", "report");

		expect(guardMode("t-issue")).toBe("report");
	});

	it("keeps a guard nobody declared blocking, as it did before the policy", () => {
		expect(guardMode("t-never-declared")).toBe("block");
	});

	it("says where each mode came from", () => {
		declareGuard({
			name: "t-say",
			class: "approval",
			description: "",
			defaultMode: "report",
		});
		setSessionMode("t-say", "block");

		const said = listGuards().find((g) => g.declaration.name === "t-say");
		expect(said?.source).toBe("session");
	});
});

describe("a guard that follows others", () => {
	beforeEach(() => {
		declareGuard({
			name: "t-panel-a",
			class: "approval",
			description: "",
			defaultMode: "report",
		});
		declareGuard({
			name: "t-panel-b",
			class: "approval",
			description: "",
			defaultMode: "report",
		});
		declareGuard({
			name: "t-chain",
			class: "redirect",
			description: "",
			defaultMode: "block",
			follows: ["t-panel-a", "t-panel-b"],
		});
	});

	it("reports while everything it serves reports", () => {
		expect(guardMode("t-chain")).toBe("report");
	});

	it("blocks once anything it serves blocks", () => {
		setSessionMode("t-panel-b", "block");

		expect(guardMode("t-chain")).toBe("block");
	});

	it("takes a setting of its own over what it follows", () => {
		setSessionMode("t-panel-b", "block");
		setSessionMode("t-chain", "off");

		expect(guardMode("t-chain")).toBe("off");
	});

	it("does not loop when two guards follow each other", () => {
		declareGuard({
			name: "t-loop-a",
			class: "redirect",
			description: "",
			defaultMode: "block",
			follows: ["t-loop-b"],
		});
		declareGuard({
			name: "t-loop-b",
			class: "redirect",
			description: "",
			defaultMode: "block",
			follows: ["t-loop-a"],
		});

		expect(["block", "report"]).toContain(guardMode("t-loop-a"));
	});
});

describe("the keys a setting may use", () => {
	it("offers names, groups, classes and all", () => {
		declareGuard({
			name: "t-keyed",
			class: "redirect",
			description: "",
			defaultMode: "block",
			groups: ["t-keygroup"],
		});

		const keys = selectorKeys();
		for (const key of ["t-keyed", "t-keygroup", "redirect", "all"]) {
			expect(keys).toContain(key);
		}
	});
});

describe("the guards section of the package config", () => {
	it("reads no section as no settings", () => {
		expect(parseGuardSection(undefined)).toEqual({ ok: true, value: {} });
	});

	it("reads modes by key", () => {
		expect(
			parseGuardSection({ modes: { commit: "block", approval: "report" } }),
		).toEqual({ ok: true, value: { commit: "block", approval: "report" } });
	});

	it("refuses a mode it does not know rather than ignoring it", () => {
		const parsed = parseGuardSection({ modes: { commit: "ask" } });

		expect(parsed.ok).toBe(false);
		expect(!parsed.ok && parsed.error).toMatch(/modes\.commit/);
	});
});

describe("a refusal under the policy", () => {
	const refusal = { block: true as const, reason: "say it plainer" };

	beforeEach(() => {
		declareGuard({
			name: "t-prose",
			class: "redirect",
			description: "",
			defaultMode: "block",
		});
	});

	it("refuses when the guard blocks", () => {
		expect(refusalUnder("t-prose", refusal, "Prose")).toEqual(refusal);
	});

	it("reports the reason and lets it through when the guard reports", () => {
		const seen: GuardReport[] = [];
		setGuardReportSink((report) => seen.push(report));
		setSessionMode("t-prose", "report");

		expect(refusalUnder("t-prose", refusal, "Prose")).toBeUndefined();
		expect(seen).toEqual([
			{
				guard: "t-prose",
				kind: "waved",
				title: "Prose",
				body: "say it plainer",
			},
		]);
	});

	it("says nothing when the guard is off", () => {
		const seen: GuardReport[] = [];
		setGuardReportSink((report) => seen.push(report));
		setSessionMode("t-prose", "off");

		expect(refusalUnder("t-prose", refusal, "Prose")).toBeUndefined();
		expect(seen).toEqual([]);
	});
});

describe("reports", () => {
	it("are dropped when nothing listens", () => {
		expect(() =>
			reportGuard({ guard: "t", kind: "shown", title: "x" }),
		).not.toThrow();
	});

	it("read back from stored data", () => {
		expect(isGuardReport({ guard: "commit", kind: "shown", title: "x" })).toBe(
			true,
		);
		expect(isGuardReport({ guard: "commit", kind: "maybe", title: "x" })).toBe(
			false,
		);
	});
});
