/**
 * Guardian contract, registration, the guard policy and reports.
 *
 * Public entry point for building command guardians.
 * Downstream packages import from here to implement the
 * detect → parse → review pipeline, to declare a guard of their own
 * so `/guards` can switch it, and to report what a guard saw.
 */

export {
	type Approval,
	approvalUnder,
	asksUnder,
	fenced,
	refusalUnder,
} from "./apply.ts";
export {
	ALL_GUARDS,
	declareGuard,
	GUARD_MODES,
	type GuardClass,
	type GuardDeclaration,
	type GuardMode,
	guardMode,
	isGuardMode,
	listGuards,
	type ModeSource,
	type ResolvedGuard,
} from "./policy.ts";
export { formatRedirectBlock } from "./redirect.ts";
export {
	type RegisterGuardianOptions,
	registerGuardian,
} from "./register.ts";
export {
	type GuardReport,
	type GuardReportKind,
	reportGuard,
} from "./report.ts";
export {
	ALLOW,
	type CommandGuardian,
	type GuardianBlock,
	type GuardianResult,
} from "./types.ts";
