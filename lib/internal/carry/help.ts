/**
 * What `pi-carry --help` says, and whether its words ask for it, read
 * before anything else so its help answers on any machine.
 */

/** What `pi-carry --help` says, each line within 72 columns. */
export const CARRY_HELP = `pi-carry carries a quest's work from one of the person's machines
to another, as \`mycelium carry\` asks it, printing a JSON line for
each thing it does.

Usage:
  pi-carry QUEST --to MACHINE
  pi-carry arrive QUEST --from MACHINE --session ID
      [--by ADDRESS --why REASON]
  pi-carry where QUEST --from MACHINE --session ID
  pi-carry fence QUEST --from MACHINE --session ID
  pi-carry settle QUEST --session ID

Commands:
  --to     carry the sessions no pi runs and the trees no session
           holds into the quest's handover, on the machine it leaves
  arrive   put one session's trees in place and place its file, on
           the machine it goes to; --by and --why tell it who
           ordered the carry and why
  where    print the folder the arrived session starts in
  fence    print what PI_SANDBOX the arrived session starts under
  settle   let go of the trees a confirmed carry left here

It exits 0 when done, 1 when a tree was refused, a done file never
came or something here holds work the carry lacks, and 2 when asked
wrongly.
`;

/** pi-carry's flags that take the word after them as their value. */
const VALUED = new Set(["--to", "--from", "--session", "--by", "--why"]);

/**
 * Whether `words` ask for pi-carry's help, by `--help` or `-h` before any
 * `--`. The word after a valued flag is its value, as a parser reads it, so
 * a reason that is exactly `--help` is carried rather than taken for help.
 */
export function asksForHelp(words: readonly string[]): boolean {
	for (let at = 0; at < words.length; at += 1) {
		const word = words[at];
		if (word === "--") return false;
		if (word === "--help" || word === "-h") return true;
		if (word !== undefined && VALUED.has(word)) at += 1;
	}
	return false;
}
