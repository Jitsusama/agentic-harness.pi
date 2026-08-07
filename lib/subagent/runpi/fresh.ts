/**
 * Reading a value out of a `.mjs` and saying so when it is not there.
 *
 * A `/reload` re-evaluates this file and every other `.ts`, and does
 * not re-evaluate a `.mjs`: measured, and the reason a whole council
 * was lost. What arrives at a use site is then not an error naming a
 * module, it is `undefined`, and what it does next depends on the
 * value. A missing string threw on `.split`, seven times, before any
 * reviewer spawned. A missing number would have been worse: passed to
 * `setTimeout` it means fire immediately, so a pipe drain would have
 * become no drain at all and nothing would have said a word.
 *
 * So the read is checked where it happens and the failure names both
 * the value and the way out. This cannot prevent the staleness. It
 * can stop it presenting as arithmetic on `undefined` half a second
 * later somewhere else.
 */

/** The kinds of value a script module hands back. */
type FromScript = string | number | ((...args: never[]) => unknown);

/**
 * A value imported from a `.mjs`, or a refusal that says why it is
 * missing.
 *
 * @param value what the import produced
 * @param named the export's name, as the `.mjs` spells it
 * @param from the module it came from, for the sentence
 */
export function fromScript<T extends FromScript>(
	value: T | undefined,
	named: string,
	from: string,
): T {
	if (value !== undefined && value !== null && value !== "") return value;
	throw new Error(
		`${named} is missing from ${from}. That module is a script, and a ` +
			"reload re-evaluates TypeScript but not a script, so a session " +
			"that reloaded after this export was added still holds the copy " +
			"from before it. Restart pi rather than reloading.",
	);
}
