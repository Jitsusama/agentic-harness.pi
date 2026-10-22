import { beforeEach, describe, expect, it } from "vitest";
import { forgetRedirects, refusalUnder } from "../../../lib/guardian/apply.ts";
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
	forgetRedirects();
});

describe("resolving a guard's mode", () => {
	it("uses the guard's own default when nothing says otherwise", () => {
		declareGuard({
			name: "t-commit",
			class: "approval",
			description: "",
			defaultMode: "redirect",
		});

		expect(guardMode("t-commit")).toBe("redirect");
	});

	it("lets config beat the default and a session override beat config", () => {
		declareGuard({
			name: "t-pr",
			class: "approval",
			description: "",
			defaultMode: "redirect",
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
			defaultMode: "redirect",
			groups: ["t-git"],
		});

		setConfiguredModes({ all: "off", safety: "redirect", "t-git": "block" });
		expect(guardMode("t-history")).toBe("block");

		setConfiguredModes({ all: "off", safety: "redirect" });
		expect(guardMode("t-history")).toBe("redirect");

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
			defaultMode: "redirect",
		});
		setConfiguredModes({ "t-issue": "block" });
		setSessionMode("all", "off");

		expect(guardMode("t-issue")).toBe("off");
	});

	it("keeps a guard nobody declared blocking, as it did before the policy", () => {
		expect(guardMode("t-never-declared")).toBe("block");
	});

	it("says where each mode came from", () => {
		declareGuard({
			name: "t-say",
			class: "approval",
			description: "",
			defaultMode: "redirect",
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
			defaultMode: "redirect",
		});
		declareGuard({
			name: "t-panel-b",
			class: "approval",
			description: "",
			defaultMode: "redirect",
		});
		declareGuard({
			name: "t-chain",
			class: "form",
			description: "",
			defaultMode: "block",
			follows: ["t-panel-a", "t-panel-b"],
		});
	});

	it("stays out of the way while nothing it serves asks a person", () => {
		// It splits chained commands so a panel can read one at a time.
		// With no panel asking there is nothing for it to protect, so it
		// only reports, rather than refusing a chain nobody will review.
		expect(guardMode("t-chain")).toBe("off");
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
			class: "form",
			description: "",
			defaultMode: "block",
			follows: ["t-loop-b"],
		});
		declareGuard({
			name: "t-loop-b",
			class: "form",
			description: "",
			defaultMode: "block",
			follows: ["t-loop-a"],
		});

		expect(["block", "off"]).toContain(guardMode("t-loop-a"));
	});
});

describe("the keys a setting may use", () => {
	it("offers names, groups, classes and all", () => {
		declareGuard({
			name: "t-keyed",
			class: "form",
			description: "",
			defaultMode: "block",
			groups: ["t-keygroup"],
		});

		const keys = selectorKeys();
		for (const key of ["t-keyed", "t-keygroup", "form", "all"]) {
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
			parseGuardSection({ modes: { commit: "block", approval: "redirect" } }),
		).toEqual({ ok: true, value: { commit: "block", approval: "redirect" } });
	});

	it("reads the old report mode as off, which does what report did", () => {
		// Report let the call through and showed the person what it saw.
		// Off now does exactly that, so a config written for report keeps
		// behaving as its author meant.
		expect(parseGuardSection({ modes: { commit: "report" } })).toEqual({
			ok: true,
			value: { commit: "off" },
		});
	});

	it("reads the old report mode as off in a restored session", () => {
		declareGuard({
			name: "t-restored",
			class: "approval",
			description: "",
			defaultMode: "block",
		});
		restoreSessionModes({ "t-restored": "report" } as never);

		expect(guardMode("t-restored")).toBe("off");
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
			class: "form",
			description: "",
			defaultMode: "block",
		});
	});

	it("refuses when the guard blocks", () => {
		expect(refusalUnder("t-prose", refusal, "Prose")).toEqual(refusal);
	});

	it("refuses the first time under redirect, saying how to go ahead anyway", () => {
		// A call waved through unseen taught the agent nothing, so it made
		// the same mistake again. The refusal is what it learns from.
		setSessionMode("t-prose", "redirect");

		const first = refusalUnder("t-prose", refusal, "Prose");

		expect(first && "block" in first && first.reason).toMatch(
			/^say it plainer\n\n.*same call again, unchanged/s,
		);
	});

	it("lets the same call through when it comes back unchanged, as an override", () => {
		// A guard can be wrong. Making the same call again is the agent
		// saying it is sure, so a wrong guard cannot corner it, and the
		// report shows the person each time that happened.
		const seen: GuardReport[] = [];
		setGuardReportSink((report) => seen.push(report));
		setSessionMode("t-prose", "redirect");

		refusalUnder("t-prose", refusal, "Prose", "git commit -m x");
		const again = refusalUnder("t-prose", refusal, "Prose", "git commit -m x");

		expect(again).toBeUndefined();
		expect(seen).toEqual([
			{
				guard: "t-prose",
				kind: "overridden",
				title: "Prose",
				body: "say it plainer",
			},
		]);
	});

	it("refuses a changed call afresh", () => {
		setSessionMode("t-prose", "redirect");

		refusalUnder("t-prose", refusal, "Prose", "git commit -m x");

		expect(
			refusalUnder("t-prose", refusal, "Prose", "git commit -m y"),
		).toBeDefined();
	});

	it("spends an override once, so the mistake made later is said again", () => {
		setSessionMode("t-prose", "redirect");

		refusalUnder("t-prose", refusal, "Prose", "same");
		refusalUnder("t-prose", refusal, "Prose", "same");

		expect(refusalUnder("t-prose", refusal, "Prose", "same")).toBeDefined();
	});

	it("never lets a blocking guard's refusal through on a retry", () => {
		refusalUnder("t-prose", refusal, "Prose", "same");

		expect(refusalUnder("t-prose", refusal, "Prose", "same")).toEqual(refusal);
	});

	it("reports the reason and lets it through when the guard is off", () => {
		// Off is the person saying stay out of the way, not stay silent:
		// what the guard saw still reaches the transcript.
		const seen: GuardReport[] = [];
		setGuardReportSink((report) => seen.push(report));
		setSessionMode("t-prose", "off");

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
		expect(
			isGuardReport({ guard: "commit", kind: "overridden", title: "x" }),
		).toBe(true);
		expect(isGuardReport({ guard: "commit", kind: "maybe", title: "x" })).toBe(
			false,
		);
	});
});
