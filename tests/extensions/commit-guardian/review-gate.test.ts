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
import {
	provideVerificationCheck,
	type VerificationScope,
} from "../../../lib/internal/verification/signal.ts";

/** A verification check that finds `problems`, keeping each scope asked. */
function failingWith(problems: string[]): VerificationScope[] {
	const asked: VerificationScope[] = [];
	provideVerificationCheck(async (scope) => {
		asked.push(scope);
		return { problems };
	});
	return asked;
}

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
	provideVerificationCheck(undefined);
	restoreSessionModes({});
	setGuardReportSink(undefined);
});

describe("commit guardian review gate", () => {
	it("blocks with the guard to switch when verification is failing, even headless", async () => {
		failingWith(["/repo/a.ts:3:1 Cannot find name 'x'."]);

		const result = await review("feat: x\n\nbody", fakeCtx(false));

		expect(result).toMatchObject({ block: true });
		const reason = (result as { reason: string }).reason;
		expect(reason).toContain("- /repo/a.ts:3:1 Cannot find name 'x'.");
		expect(reason).toContain("/guards commit-verification report");
	});

	it("asks about the tree the commit lands in", async () => {
		const asked: VerificationScope[] = [];
		provideVerificationCheck(async (scope) => {
			asked.push(scope);
			return undefined;
		});
		const guardian = createCommitGuardian(fakePi());
		const parsed = guardian.parse(
			"cd /work/tree && git commit -m 'fix: x' -m 'Because.'",
		);
		if (!parsed) throw new Error("not parsed");

		const result = await guardian.review(parsed, fakeCtx(false), "report");

		expect(result).toBeUndefined();
		expect(asked.map((s) => s.dir)).toEqual(["/work/tree"]);
	});

	it("does not ask at all while its guard is off", async () => {
		const asked = failingWith(["/repo/a.ts:1:0 broken"]);
		setSessionMode("commit-verification", "off");

		const result = await review("feat: x\n\nbody", fakeCtx(false), "report");

		expect(result).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("lets a failing verification through with a report once its guard reports", async () => {
		failingWith(["/repo/a.ts:1:0 broken"]);
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
