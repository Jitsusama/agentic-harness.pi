/**
 * Judging how big a thing you have to hit is.
 *
 * WCAG 2.2 added Target Size (Minimum) at 24 by 24 CSS pixels,
 * and it is more interesting than a measurement because of its
 * exceptions. A small target sitting in open space passes; the
 * same target crowded against its neighbours does not. Checking
 * the size and skipping the spacing rule would fail links in
 * prose and pass a row of cramped icon buttons, which is
 * precisely backwards.
 */

import type { Rect } from "../element/box.js";
import type { A11yFinding } from "./axe.js";

/**
 * Something a person is expected to hit.
 *
 * Named for the criterion rather than called a Target, because
 * a target elsewhere in this library is an element named by
 * role and accessible name so it can be acted on. Two meanings
 * for one word in one library is a trap worth avoiding.
 */
export interface HitTarget {
	readonly id: string;
	readonly rect: Rect;
	/**
	 * Whether the target sits in a line of text, which the
	 * specification excepts outright. Inline is a fact about
	 * layout and must come from the browser, never from a guess
	 * about the element's tag.
	 */
	readonly inline?: boolean;
	/** Whether the browser, not the page, decides its size. */
	readonly userAgentControlled?: boolean;
	/** Whether the page offers the same action somewhere bigger. */
	readonly hasLargerAlternative?: boolean;
	/** Whether this exact size is essential to what it does. */
	readonly essential?: boolean;
}

/** 2.5.8 Target Size (Minimum), level AA. */
export const MINIMUM_TARGET_PX = 24;

/** 2.5.5 Target Size (Enhanced), level AAA. */
export const ENHANCED_TARGET_PX = 44;

/** Which of the two target-size criteria is being applied. */
export type TargetLevel = "AA" | "AAA";

/** Why an undersized target is nonetheless allowed. */
export type TargetException =
	| "inline"
	| "user-agent"
	| "alternative"
	| "essential"
	| "spacing";

/** What was concluded about one target. */
export interface TargetVerdict {
	readonly id: string;
	readonly width: number;
	readonly height: number;
	readonly required: number;
	readonly passes: boolean;
	/** Present when it is undersized but excepted. */
	readonly exception?: TargetException;
	/** What it is crowded by, when spacing is what failed it. */
	readonly crowdedBy?: readonly string[];
}

function centre(rect: Rect): { x: number; y: number } {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Whether a target is under the size the rule asks for. */
function undersized(target: HitTarget, required: number): boolean {
	return target.rect.width < required || target.rect.height < required;
}

/**
 * Whether an undersized target's circle clashes with a
 * neighbour.
 *
 * The rule is two rules wearing one name. An undersized
 * target's circle must not intersect another target, meaning
 * that target's actual box, and must not intersect the circle
 * of another undersized target. Treating every neighbour as a
 * circle passes a small control sitting hard against the edge
 * of a large one, which is exactly the crowding the criterion
 * exists to catch.
 */
function clashes(
	target: HitTarget,
	other: HitTarget,
	required: number,
): boolean {
	const radius = required / 2;
	const from = centre(target.rect);

	if (undersized(other, required)) {
		const to = centre(other.rect);
		return Math.hypot(from.x - to.x, from.y - to.y) < required;
	}

	// Against a full-size neighbour it is the circle against that
	// neighbour's box: the nearest point of the box to the centre.
	const nearestX = Math.max(
		other.rect.x,
		Math.min(from.x, other.rect.x + other.rect.width),
	);
	const nearestY = Math.max(
		other.rect.y,
		Math.min(from.y, other.rect.y + other.rect.height),
	);
	return Math.hypot(from.x - nearestX, from.y - nearestY) < radius;
}

/**
 * Judge one target against its neighbours.
 *
 * The order of the exceptions follows the specification: the
 * outright ones are checked before the spacing rule, since a
 * target that is excepted for being inline is never measured
 * against its neighbours at all.
 */
export function judgeTarget(
	target: HitTarget,
	neighbours: readonly HitTarget[],
	level: TargetLevel = "AA",
): TargetVerdict {
	const required = level === "AAA" ? ENHANCED_TARGET_PX : MINIMUM_TARGET_PX;
	const { width, height } = target.rect;
	const base = { id: target.id, width, height, required };

	if (width >= required && height >= required) {
		return { ...base, passes: true };
	}

	// The outright exceptions do not care about the neighbours.
	const excepted = outrightException(target);
	if (excepted) return { ...base, passes: true, exception: excepted };

	// Enhanced has no spacing exception; it is a plain minimum.
	if (level === "AAA") return { ...base, passes: false };

	const crowdedBy = neighbours
		.filter((other) => other.id !== target.id)
		.filter((other) => clashes(target, other, required))
		.map((other) => other.id);

	if (crowdedBy.length === 0) {
		return { ...base, passes: true, exception: "spacing" };
	}
	return { ...base, passes: false, crowdedBy };
}

function outrightException(target: HitTarget): TargetException | undefined {
	if (target.inline) return "inline";
	if (target.userAgentControlled) return "user-agent";
	if (target.hasLargerAlternative) return "alternative";
	if (target.essential) return "essential";
	return undefined;
}

/** Judge every target against every other. */
export function judgeTargets(
	targets: readonly HitTarget[],
	level: TargetLevel = "AA",
): readonly TargetVerdict[] {
	return targets.map((target) => judgeTarget(target, targets, level));
}

/** How many failures to name before summarising the rest. */
const MAX_NAMED = 10;

/** Say what the target sweep found. */
export function renderTargets(verdicts: readonly TargetVerdict[]): string {
	if (verdicts.length === 0) return "No targets to measure.";

	const failed = verdicts.filter((verdict) => !verdict.passes);
	const excepted = verdicts.filter((verdict) => verdict.exception);
	const required = verdicts[0]?.required ?? MINIMUM_TARGET_PX;

	if (failed.length === 0) {
		const tail =
			excepted.length === 0
				? ""
				: ` ${excepted.length} were under ${required} pixels but excepted.`;
		return `All ${verdicts.length} targets meet ${required} by ${required}.${tail}`;
	}

	const lines = [
		`${failed.length} of ${verdicts.length} targets are smaller than ` +
			`${required} by ${required} with nothing excepting them.`,
		"",
	];
	for (const verdict of failed.slice(0, MAX_NAMED)) {
		const size = `${round(verdict.width)} by ${round(verdict.height)}`;
		const crowd =
			verdict.crowdedBy && verdict.crowdedBy.length > 0
				? `, crowded by ${verdict.crowdedBy.join(", ")}`
				: "";
		lines.push(`  ${verdict.id}  ${size}${crowd}`);
	}
	if (failed.length > MAX_NAMED) {
		lines.push(`  ... and ${failed.length - MAX_NAMED} more`);
	}
	return lines.join("\n");
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * A captured target, as the page reports it.
 *
 * Carries the selector alongside the facts the judgment needs,
 * so a finding can point at something a reader can find.
 */
export interface CapturedTarget extends HitTarget {
	readonly selector: string;
}

/**
 * Turn target verdicts into findings, so they merge with the
 * rest of the accessibility report instead of living apart.
 *
 * Failures are violations of a real criterion. An excepted
 * target is not reported at all: the exception is the criterion
 * working as written, not a thing to look at.
 */
export function targetFindings(
	targets: readonly CapturedTarget[],
	level: TargetLevel = "AA",
): readonly A11yFinding[] {
	const byId = new Map(targets.map((target) => [target.id, target]));
	const failed = judgeTargets(targets, level).filter(
		(verdict) => !verdict.passes,
	);
	if (failed.length === 0) return [];

	const required = failed[0]?.required ?? MINIMUM_TARGET_PX;
	return [
		{
			rule: "target-is-big-enough",
			kind: "violation",
			impact: "serious",
			authority: "wcag",
			criteria: [level === "AAA" ? "2.5.5" : "2.5.8"],
			levels: [level],
			help:
				`A pointer target smaller than ${required} by ${required} ` +
				"pixels, with no larger alternative and not enough clear " +
				"space around it to be excepted.",
			nodes: failed.map((verdict) => ({
				selector: byId.get(verdict.id)?.selector ?? verdict.id,
				html: "",
				messages: [
					`Measured ${Math.round(verdict.width)} by ` +
						`${Math.round(verdict.height)} pixels` +
						(verdict.crowdedBy && verdict.crowdedBy.length > 0
							? `, and too close to ${verdict.crowdedBy.length} other ` +
								`${
									verdict.crowdedBy.length === 1 ? "target" : "targets"
								} to be excepted for spacing.`
							: "."),
				],
			})),
		},
	];
}
