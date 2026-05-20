/**
 * Pure renderer for the post gate's content area.
 *
 * Kept separate from `post-gate.ts` so tests can
 * exercise the layout without dragging in the panel
 * runtime.
 */

import type { ContentRenderer } from "../../lib/ui/types.js";
import type { ReviewEvent } from "./post.js";

/** One finding line in the gate's listing. */
export interface PostGateFindingLine {
	readonly id: number;
	readonly label: string;
	readonly subject: string;
	readonly location: string;
}

/** Everything the post gate needs to render its content. */
export interface PostGateSummary {
	readonly event: ReviewEvent;
	readonly body: string;
	readonly inlineCount: number;
	readonly bodyFindingCount: number;
	readonly stackFindingCount: number;
	readonly skippedCount: number;
	readonly findings: readonly PostGateFindingLine[];
}

/**
 * Render the post gate's content area.
 *
 * Headers in order: event line, count line(s), review
 * body, finding listing. The user sees enough to spot
 * a bad post before pressing Enter.
 */
export function renderPostGateContent(
	summary: PostGateSummary,
): ContentRenderer {
	return (theme, _width) => {
		const lines: string[] = [];

		lines.push(theme.fg("accent", ` Review event: ${summary.event}`));

		const countParts: string[] = [];
		if (summary.inlineCount > 0) {
			countParts.push(`${summary.inlineCount} inline`);
		}
		if (summary.bodyFindingCount > 0) {
			countParts.push(`${summary.bodyFindingCount} in body`);
		}
		if (summary.stackFindingCount > 0) {
			countParts.push(`${summary.stackFindingCount} cross-PR`);
		}
		if (countParts.length > 0) {
			lines.push(theme.fg("dim", `  ${countParts.join(" · ")}`));
		}
		if (summary.skippedCount > 0) {
			lines.push(theme.fg("warning", `  ${summary.skippedCount} skipped`));
		}

		if (summary.body.length > 0) {
			lines.push("");
			lines.push(theme.fg("dim", " Review body:"));
			for (const bodyLine of summary.body.split("\n")) {
				lines.push(` ${theme.fg("text", bodyLine)}`);
			}
		}

		if (summary.findings.length > 0) {
			lines.push("");
			lines.push(theme.fg("dim", " Findings:"));
			for (const f of summary.findings) {
				lines.push(
					` ${theme.fg("accent", `[${f.id}]`)} ${theme.fg("text", `[${f.label}]`)} ${f.subject} ${theme.fg("dim", f.location)}`,
				);
			}
		}

		return lines;
	};
}
