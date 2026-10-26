/**
 * Git, told that there is nobody here to ask.
 *
 * Found by driving `resume` and watching it never come back. `git rebase
 * --continue` finishes a conflicted pick by running
 * `git commit -F .git/rebase-merge/message -e`, and the `-e` means edit: git
 * launched an editor and waited for a human on a stdin that no human was
 * attached to. The tool sat there forever, and because the working layer never
 * passed the caller's abort signal down to the child, there was no way to stop
 * it either. Two faults, and the second is what turned a wrong answer into a
 * wedged session.
 *
 * A worse property than the hang itself: the tree is left mid-rebase. Somebody
 * who kills the session finds a repository in a state they did not ask for and
 * no tool willing to talk about it, which is the exact situation the halt design
 * exists to prevent.
 *
 * So every git call that can reach an editor says up front that there is not one.
 * `true` exits zero without reading anything, so git accepts the message it
 * already had, which is the message the commit is supposed to keep.
 *
 * That is the rebase family and not `commit`, which this layer always calls with
 * `-m`: git never consults an editor when the message is on the command line, and
 * flags that cannot change an outcome are noise at the call site. A passphrase
 * prompt from a signing key is a real hang and a different problem, since the
 * honest answer to it is not to disable signing. The abort signal covers that
 * one.
 */

/**
 * Global git flags that guarantee a command cannot stop to ask a human.
 *
 * Both editors are named because git reaches for two different ones and only one
 * of them is the commit message. `sequence.editor` presents a todo list, which
 * an interactive rebase needs and nothing here asks for today. It is set anyway:
 * the cost is two arguments nobody sees, and the failure it prevents is a
 * process wedged with a repository half-rewritten.
 */
const NO_EDITOR: readonly string[] = [
	"-c",
	"core.editor=true",
	"-c",
	"sequence.editor=true",
];

/**
 * Git arguments with the editor turned off.
 *
 * Wrap the whole argument list rather than remembering to add flags at each call
 * site, since the call that forgets is the one that hangs, and it hangs only when
 * a rebase actually conflicts. That is a fault which passes every test and waits
 * for somebody's real conflict to appear.
 *
 * These are global flags, so they go before the subcommand. Anything already
 * global in the list, `-C` in particular, stays valid in any order beside them.
 */
export function unattended(args: readonly string[]): string[] {
	return [...NO_EDITOR, ...args];
}
