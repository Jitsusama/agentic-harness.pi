import { afterEach, describe, expect, it } from "vitest";
import { createCommitGuardian } from "../../../extensions/commit-guardian/review.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";
import { setVerificationFailing } from "../../../lib/internal/verification/signal.ts";

// Derive the pi and context types from the factory so the test never
// imports the pi package directly (which does not resolve for test
// files under this tsconfig).
type Guardian = ReturnType<typeof createCommitGuardian>;
type Pi = Parameters<typeof createCommitGuardian>[0];
type Ctx = Parameters<NonNullable<Guardian["review"]>>[1];

function fakePi(): Pi {
	return { appendEntry: () => {} } as unknown as Pi;
}

function fakeCtx(hasUI: boolean): Ctx {
	return {
		hasUI,
		sessionManager: { getEntries: () => [] },
	} as unknown as Ctx;
}

async function review(
	message: string,
	ctx: Ctx,
	mode: "report" | "block" = "block",
) {
	const guardian = createCommitGuardian(fakePi());
	if (!guardian.review) throw new Error("guardian has no review step");
	return guardian.review({ message, isAmend: false }, ctx, mode);
}

afterEach(() => {
	setVerificationFailing(false);
	restoreSessionModes({});
	setGuardReportSink(undefined);
});

describe("commit guardian review gate", () => {
	it("blocks with the guard to switch when verification is failing, even headless", async () => {
		setVerificationFailing(true);

		const result = await review("feat: x\n\nbody", fakeCtx(false));

		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain(
			"/guards commit-verification report",
		);
	});

	it("lets a failing verification through with a report once its guard reports", async () => {
		setVerificationFailing(true);
		setSessionMode("commit-verification", "report");
		const seen: GuardReport[] = [];
		setGuardReportSink((r) => seen.push(r));

		const result = await review(
			"docs: clarify setup\n\nThis explains the steps.",
			fakeCtx(false),
		);

		expect(result).toBeUndefined();
		expect(seen.map((r) => r.guard)).toEqual(["commit-verification"]);
	});

	it("reports the message and its marks in report mode", async () => {
		const seen: GuardReport[] = [];
		setGuardReportSink((r) => seen.push(r));

		const result = await review(
			"docs: clarify setup\n\nThis explains the steps.",
			fakeCtx(true),
			"report",
		);

		expect(result).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ guard: "commit", kind: "shown" });
		expect(seen[0].body).toContain("docs: clarify setup");
		expect(seen[0].notes).toContain("\u2713 conventional");
	});

	it("blocks a prose violation before the review panel", async () => {
		const result = await review(
			"feat: x\n\nthis body uses an emdash \u2014 which prose bans",
			fakeCtx(true),
		);

		expect(result).toMatchObject({ block: true });
	});

	it("allows a clean commit headlessly without stalling", async () => {
		const result = await review(
			"docs: clarify setup\n\nThis explains the steps.",
			fakeCtx(false),
		);

		expect(result).toBeUndefined();
	});
});
