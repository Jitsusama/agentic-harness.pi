/**
 * Writing a number down the same way everywhere.
 *
 * Citations are read by a language model and pinned by tests, and
 * both want one answer. `toLocaleString` gives the machine's
 * answer: the same count reads as 18,004 here and 18.004 on a
 * runner configured for German, where a model has every reason to
 * take it for eighteen and a bit.
 *
 * Grouped by hand rather than with an explicit locale, because
 * locale data is a dependency of the runtime and this is not worth
 * one.
 */

/** A whole number, grouped in threes with commas. */
export function count(value: number): string {
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
