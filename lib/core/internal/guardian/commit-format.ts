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

/** The widest a body line may be. */
const BODY_WIDTH = 72;

/** A list item's marker and the space after it. */
const LIST_MARKER = /^([-*+]|\d+\.)\s+/;

/**
 * A body with its over-long prose lines wrapped at 72.
 *
 * Wrapping takes no judgement, so refusing a message for it only cost a
 * turn: 20 refusals since 12 October, one line a time, for lines a few
 * characters over. A paragraph that already fits is returned untouched,
 * so a body somebody laid out by hand keeps its breaks. A list item wraps
 * under its own text. A fenced block and an indented line are code or
 * quoted output, where a break changes what they say, so they are left
 * alone, as is a single word too long for any line, such as a URL.
 */
export function wrapBody(body: string): string {
	const out: string[] = [];
	let fenced = false;
	for (const block of body.split(/\n{2,}/)) {
		const fences = block.match(/^```/gm)?.length ?? 0;
		const inCode = fenced || fences > 0;
		if (fences % 2 === 1) fenced = !fenced;
		out.push(inCode ? block : wrapParagraph(block));
	}
	return out.join("\n\n");
}

/** One paragraph, or the list items in it, wrapped when a line is too long. */
function wrapParagraph(block: string): string {
	const lines = block.split("\n");
	if (lines.every((line) => line.length <= BODY_WIDTH)) return block;
	if (lines.some((line) => /^(\t| {4})/.test(line))) return block;

	// Each item starts at a marker; a line without one continues the item.
	const items: string[][] = [];
	for (const line of lines) {
		const last = items.at(-1);
		if (LIST_MARKER.test(line) || !last) items.push([line]);
		else last.push(line);
	}
	return items
		.map((item) => {
			const joined = item.map((line) => line.trim()).join(" ");
			const marker = joined.match(LIST_MARKER)?.[0] ?? "";
			return fill(
				joined.slice(marker.length),
				marker,
				" ".repeat(marker.length),
			);
		})
		.join("\n");
}

/** Words laid greedily into lines no wider than 72 where a word allows. */
function fill(text: string, first: string, rest: string): string {
	const lines: string[] = [];
	let line = first;
	let empty = true;
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (!empty && line.length + 1 + word.length > BODY_WIDTH) {
			lines.push(line);
			line = rest + word;
		} else {
			line = empty ? line + word : `${line} ${word}`;
		}
		empty = false;
	}
	lines.push(line);
	return lines.join("\n");
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
