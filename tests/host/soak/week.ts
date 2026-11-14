/**
 * A real week's turns, cut into the soak's days. week.json holds the
 * prompts typed in each session log of the week of 7 to 14 November on
 * optimus, busiest first: 594 sessions and 35,642 prompts. A host keeps
 * about 20 conversations live, so each day's run is 20 conversations.
 * The sessions are dealt to the days in turn, busiest first and back
 * again, so the days weigh alike; each day's are dealt to its
 * conversations the same way, so each conversation is one of the day's
 * 20 busiest sessions with a few of its quiet ones after it, as a person
 * comes back to a conversation. So the seven days take the week's every
 * prompt and each keeps its busiest sessions whole: the busiest day's
 * busiest conversation takes 1,200 turns and its quietest 207, where
 * packing each into whichever held fewest made all but one about 233.
 */

/** The days a week's run is cut into. */
export const DAYS = 7;

/** The conversations each day's run keeps live, as a host does. */
export const CONVERSATIONS = 20;

/**
 * Each day's conversations' turns, the busiest first, from the prompts
 * of each session in `sessions`, cut into `days` days of `conversations`.
 */
export function daysOf(
	sessions: readonly number[],
	days = DAYS,
	conversations = CONVERSATIONS,
): number[][] {
	return dealt(sessions, days).map((day) =>
		dealt(day, conversations)
			.map((one) => one.reduce((sum, prompts) => sum + prompts, 0))
			.filter((turns) => turns > 0)
			.sort((a, b) => b - a),
	);
}

/** `sessions`, busiest first, dealt into `hands` in turn, there and back. */
function dealt(sessions: readonly number[], hands: number): number[][] {
	const each: number[][] = Array.from({ length: hands }, () => []);
	const busiestFirst = [...sessions].sort((a, b) => b - a);
	for (const [index, prompts] of busiestFirst.entries()) {
		const place = index % hands;
		const back = Math.floor(index / hands) % 2 === 1;
		each[back ? hands - 1 - place : place]?.push(prompts);
	}
	return each;
}
