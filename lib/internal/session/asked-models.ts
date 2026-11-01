/**
 * Whether a fleet or a review round may run on a model the agent named.
 *
 * Sessions spread their fleets and councils across models, GPT and
 * Gemini beside Claude, for a variety of views, and on 1 November Joel
 * judged it worth nothing: the spread a fleet needs comes from its
 * personas, on one model. So a model the agent names itself, on a job,
 * a run's defaults or a round's `who`, must be the one the run uses when
 * nothing names one: the config's, else the session's. Another is
 * refused unless the person named that model in what they typed to this
 * session. The config stays the person's to set, so what it names is
 * never refused.
 */

/**
 * How many of the person's messages are kept to look for a model in:
 * enough for a request made a few messages before the fleet it is for.
 */
const MOST_REMEMBERED = 20;

/** What the person typed to this session, newest last. */
export interface PersonsWords {
	/** A message the person typed arrived. */
	heard(text: string): void;
	readonly said: readonly string[];
}

/** An empty memory of what the person typed, holding the newest few. */
export function personsWords(most = MOST_REMEMBERED): PersonsWords {
	const said: string[] = [];
	return {
		heard(text) {
			said.push(text);
			if (said.length > most) said.splice(0, said.length - most);
		},
		said,
	};
}

/**
 * Why `named` is refused for a fleet or a round whose usual model is
 * `usual`, or nothing when it may run: it is the usual model, nothing
 * is usual, or the person named it in `said`.
 */
export function refusedModel(
	named: string,
	usual: string | undefined,
	said: readonly string[],
): string | undefined {
	if (usual === undefined || sameModel(named, usual)) return undefined;
	if (said.some((text) => namesModel(text, named, usual))) return undefined;
	return `${named} is refused: fleets and review rounds run on ${usual}, the model they use when nothing names one, and get their spread from personas rather than other models. Leave the model out and give each job or reviewer a distinct persona instead. Another model runs only when the person asks for it by name, or when the config names it.`;
}

/** Whether `a` and `b` are one model, one written without its provider. */
function sameModel(a: string, b: string): boolean {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	if (x === y) return true;
	if (x.includes("/") && y.includes("/")) return false;
	return idOf(x) === idOf(y);
}

/**
 * Whether the person's `text` names `model`: its id however it is
 * spaced or punctuated ("claude opus 4.1" for `claude-opus-4-1`), or a
 * word of its id that `usual`'s doesn't share ("gemini" for
 * `gemini-3-pro`, "sonnet" for `claude-sonnet-5` beside Opus).
 */
function namesModel(text: string, model: string, usual: string): boolean {
	const said = text.toLowerCase();
	const id = idOf(model.toLowerCase());
	if (squeezed(said).includes(squeezed(id))) return true;
	const shared = new Set(wordsOf(idOf(usual.toLowerCase())));
	return wordsOf(id)
		.filter((word) => !shared.has(word))
		.some((word) => new RegExp(`\\b${word}\\b`).test(said));
}

/** A model's id without its provider. */
function idOf(model: string): string {
	return model.slice(model.lastIndexOf("/") + 1);
}

/** Only the letters and digits of `text`. */
function squeezed(text: string): string {
	return text.replace(/[^a-z0-9]/g, "");
}

/** The words of letters in a model's id. */
function wordsOf(id: string): string[] {
	return id.match(/[a-z]+/g) ?? [];
}
