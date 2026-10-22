import { beforeEach, describe, expect, it } from "vitest";
import { approvalUnder } from "../../../lib/guardian/apply.ts";
import {
	declareGuard,
	restoreSessionModes,
	setConfiguredModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";
import {
	comeBack,
	goAway,
	heldCalls,
	resetAway,
} from "../../../lib/internal/away/state.ts";

const GUARD = "t-send";

let reports: GuardReport[];

beforeEach(() => {
	restoreSessionModes({});
	setConfiguredModes({});
	resetAway();
	reports = [];
	setGuardReportSink((report) => reports.push(report));
	declareGuard({
		name: GUARD,
		class: "approval",
		description: "",
		defaultMode: "block",
	});
});

describe("an approval gate while the person is here", () => {
	it("asks when its guard blocks", () => {
		expect(approvalUnder(GUARD, "Send", () => "hi").kind).toBe("ask");
	});

	it("goes ahead and reports when its guard redirects", () => {
		setSessionMode(GUARD, "redirect");

		expect(approvalUnder(GUARD, "Send", () => "hi").kind).toBe("go");
		expect(reports.map((r) => r.kind)).toEqual(["shown"]);
	});

	it("goes ahead and still reports when its guard is off", () => {
		// Off keeps a guard out of the way, not out of sight.
		setSessionMode(GUARD, "off");

		expect(approvalUnder(GUARD, "Send", () => "hi").kind).toBe("go");
		expect(reports.map((r) => r.kind)).toEqual(["shown"]);
	});
});

describe("an approval gate while the person is away", () => {
	beforeEach(() => {
		goAway("asleep");
	});

	it("holds the call instead of asking, and says nothing was sent", () => {
		const approval = approvalUnder(GUARD, "Send to #team", () => "hi");

		expect(approval.kind).toBe("held");
		const reason = approval.kind === "held" ? approval.reason : "";
		expect(reason).toContain("Held as #1 (Send to #team)");
		expect(reason).toContain("Nothing was sent.");
		expect(reason).toContain("do not try another way round the gate");
		expect(heldCalls().map((h) => h.title)).toEqual(["Send to #team"]);
		expect(reports.map((r) => r.kind)).toEqual(["held"]);
	});

	it("holds a repeated call once", () => {
		approvalUnder(GUARD, "Send", () => "hi");
		const again = approvalUnder(GUARD, "Send", () => "hi");

		expect(again.kind === "held" && again.reason).toContain("#1");
		expect(heldCalls()).toHaveLength(1);
	});

	it("still goes ahead when its guard redirects", () => {
		setSessionMode(GUARD, "redirect");

		expect(approvalUnder(GUARD, "Send", () => "hi").kind).toBe("go");
		expect(heldCalls()).toEqual([]);
	});
});

describe("a held call made again once the person is back", () => {
	it("asks, since coming back approves nothing", () => {
		goAway();
		approvalUnder(GUARD, "Send", () => "hi");
		comeBack();

		expect(approvalUnder(GUARD, "Send", () => "hi").kind).toBe("ask");
	});
});
