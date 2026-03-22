/**
 * Validates commit messages against conventional commit format,
 * subject length limits and body line wrap rules.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";

export interface CommitValidation {
	subjectLength: number;
	subjectOk: boolean;
	bodyWrapOk: boolean;
	bodyLongestLine: number;
	bodyLongestLineNum: number;
	conventionalOk: boolean;
}

export function validate(message: string): CommitValidation {
	const lines = message.split("\n");
	const subject = lines[0] || "";
	const bodyLines = lines.length > 2 ? lines.slice(2) : [];

	let bodyLongestLine = 0;
	let bodyLongestLineNum = 0;
	for (let i = 0; i < bodyLines.length; i++) {
		const lineLen = bodyLines[i]?.length ?? 0;
		if (lineLen > bodyLongestLine) {
			bodyLongestLine = lineLen;
			bodyLongestLineNum = i + 3; // offset for subject + blank line
		}
	}

	return {
		subjectLength: subject.length,
		subjectOk: subject.length <= 50,
		bodyWrapOk: bodyLongestLine <= 72,
		bodyLongestLine,
		bodyLongestLineNum,
		conventionalOk: /^[a-z]+(\([a-z0-9/_-]+\))?!?:\s/.test(subject),
	};
}

/** Render validation as a compact indicator line. */
export function renderValidation(v: CommitValidation, theme: Theme): string {
	const parts: string[] = [];
	const dot = theme.fg("dim", " · ");

	parts.push(
		v.subjectOk
			? theme.fg("success", `✓ ${v.subjectLength} chars`)
			: theme.fg("warning", `⚠ ${v.subjectLength} chars (limit: 50)`),
	);

	if (v.bodyLongestLine > 0) {
		parts.push(
			v.bodyWrapOk
				? theme.fg("success", "✓ wrap")
				: theme.fg(
						"warning",
						`⚠ line ${v.bodyLongestLineNum}: ${v.bodyLongestLine} chars`,
					),
		);
	}

	parts.push(
		v.conventionalOk
			? theme.fg("success", "✓ conventional")
			: theme.fg("warning", "⚠ not conventional"),
	);

	return ` ${parts.join(dot)}`;
}

/** Render a commit message as gate content lines. */
export function renderCommitContent(
	message: string,
	isAmend: boolean,
): (theme: Theme, width: number) => string[] {
	const lines = message.split("\n");
	const subject = lines[0] || "";
	const bodyLines = lines.length > 2 ? lines.slice(2) : [];
	const validation = validate(message);

	return (theme, _width) => {
		const out: string[] = [];

		out.push(theme.fg("text", ` ${subject}`));

		if (bodyLines.length > 0) {
			out.push("");
			for (const line of bodyLines) {
				out.push(` ${theme.fg("text", line)}`);
			}
		}

		if (isAmend) {
			out.push("");
			out.push(theme.fg("warning", " ⚠ Amends previous commit"));
		}

		out.push("");
		out.push(renderValidation(validation, theme));

		return out;
	};
}
