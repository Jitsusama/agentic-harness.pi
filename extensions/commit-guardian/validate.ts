/**
 * Validates commit messages against conventional commit format,
 * subject length limits and body line wrap rules.
 */

export interface CommitValidation {
	subjectLength: number;
	subjectOk: boolean;
	bodyWrapOk: boolean;
	bodyLongestLine: number;
	bodyLongestLineNum: number;
	conventionalOk: boolean;
}

/** Validate a commit message against conventional commit rules. */
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
