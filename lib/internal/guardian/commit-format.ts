/**
 * Validates commit messages against conventional commit format,
 * subject length limits and body line wrap rules.
 *
 * Shared rather than owned by the guardian, because there are two
 * roads into the same repository and a rule enforced on one of them
 * is not enforced. The guardian meets a commit typed into a shell by
 * intercepting the command; `work record` never runs a command at
 * all, committing through the exec seam, so it arrived behind the
 * guardian rather than in front of it and was held only to the prose
 * rules. This module is what both roads now ask.
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

/**
 * What is wrong with a commit message, said so a caller can fix it.
 *
 * For the road with nobody watching. The guardian renders the same
 * facts as ticks and warnings next to a panel, which informs a person
 * who is already deciding; a caller that gets a list of sentences can
 * act on it without one. Empty means the message is fine.
 *
 * Each complaint names the measurement rather than the rule, because
 * "subject is 63 characters, and the limit is 50" can be acted on and
 * "subject too long" sends the reader to go and count.
 */
export function complaintsAbout(message: string): string[] {
	const checked = validate(message);
	const said: string[] = [];
	if (!checked.conventionalOk) {
		said.push(
			"the subject is not conventional form, which is type(scope): subject, " +
				"with the scope optional and the type lower case",
		);
	}
	if (!checked.subjectOk) {
		said.push(
			`the subject is ${checked.subjectLength} characters and the limit is 50`,
		);
	}
	if (!checked.bodyWrapOk) {
		said.push(
			`body line ${checked.bodyLongestLineNum} is ${checked.bodyLongestLine} ` +
				"characters and the limit is 72",
		);
	}
	return said;
}
