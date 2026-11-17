/**
 * When an open may answer for its conversation's first words: once
 * durable holds them, or pi took them as a command of its own.
 */

/** What sending the first words to pi gives to wait on. */
export interface FirstWords {
	/** pi's prompt, which answers once it has done with the words. */
	readonly prompting: Promise<void>;
	/** Settles once durable commits the next prompt, or rejects with why not. */
	readonly admitted: Promise<void>;
	/** Settles once pi took the words as a command, which durable never holds. */
	readonly taken: Promise<void>;
	/** Whether pi said it started a run of its own for the words. */
	readonly started: () => boolean;
}

/** Settles once the first words are held or taken, or rejects as pi's prompt does. */
export function firstWordsHeld(words: FirstWords): Promise<void> {
	// pi answers at once for words it only queued behind a run under way, or
	// put off while a run settled: durable holds those only once a run takes
	// them. A run pi started for them was admitted before it answers.
	const answered = words.prompting.then(() =>
		words.started() ? undefined : words.admitted,
	);
	return Promise.race([words.admitted, words.taken, answered]);
}
