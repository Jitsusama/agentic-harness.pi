/**
 * What `pi-carry --help` says, and whether its words ask for it, read
 * before any of the person's state so its help answers on any machine.
 */

/** What `pi-carry --help` says, each line within 72 columns. */
export const CARRY_HELP = `pi-carry carries a quest's work from one of the person's machines
to another, as \`mycelium carry\` asks it. A carry, an arrival and a
settling print a JSON line for each thing they do. Where and fence
print a bare answer, fence nothing for a session that runs unfenced,
and say why they couldn't on stderr.

Usage:
  pi-carry QUEST --to MACHINE
  pi-carry arrive QUEST --from MACHINE --session ID
      [--by ADDRESS --why REASON]
  pi-carry where QUEST --from MACHINE --session ID
  pi-carry fence QUEST --from MACHINE --session ID
  pi-carry settle QUEST --session ID

Forms:
  --to     carry the sessions no pi runs and the trees no session
           holds into the quest's handover, on the machine it leaves
  arrive   put one session's trees in place and place its file, on
           the machine it goes to; --by and --why tell it who
           ordered the carry and why
  where    print the folder the arrived session starts in
  fence    print what PI_SANDBOX the arrived session starts under
  settle   let go of the trees a confirmed carry left here

A value starting with a dash goes in one word, as --why=-h.

It exits 0 when done, 1 when it couldn't do all it was asked, a line
saying why, and 2 when asked wrongly.
`;

/**
 * Whether `words` ask for pi-carry's help, by `--help` or `-h` anywhere
 * before `--`. Its parser refuses a value starting with a dash given as
 * the next word, so no value is lost to help; one given in the same word,
 * as `--why=--help`, is that word and never asks.
 */
export function asksForHelp(words: readonly string[]): boolean {
	for (const word of words) {
		if (word === "--") return false;
		if (word === "--help" || word === "-h") return true;
	}
	return false;
}
