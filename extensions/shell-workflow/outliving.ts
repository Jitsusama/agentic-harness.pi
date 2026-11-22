/**
 * How a run meant to outlive its command and its host is told to start.
 *
 * A host reaps every process carrying a command's marks, at a stop and at
 * its next start (`host/engine/tool-children.ts`), and spares only a
 * cgroup outside pi's own and outside the jobs slice (`reap.ts`). Since
 * the systemd-run wrapper put an agent's user units in the caller's
 * slice, a `systemd-run --user --scope` lands in the jobs slice and still
 * carries the marks, so it dies with the host. A transient service starts
 * from the user manager, not the command, so it carries none, wherever
 * its slice. Apart from the rule naming the doors that don't work,
 * because this is what changes when systemd's reach does.
 *
 * A service takes the user manager's environment, `SSH_ASKPASS` and
 * `DISPLAY` among them, so an ssh in it with no terminal would ask on
 * the person's screen. `SSH_ASKPASS_REQUIRE=never` is what keeps ssh
 * from asking; an empty `GIT_ASKPASS` is what keeps git from falling
 * back to `core.askPass` or ssh's program, since git reads a set but
 * empty one as no program at all; the empty `SSH_ASKPASS` matches the
 * shell's.
 *
 * It takes the command's `TMPDIR` too, the loaded quest's scratch, since
 * a service left to the system's `/tmp` shares it with every run on the
 * machine: on 21 November a test suite started that way cleared its temp
 * folder before each test, which was `/tmp`, three times in one night.
 */

import type { Sandbox } from "../../lib/internal/sandbox/sandbox.ts";

/**
 * What a session in `kind` of sandbox is told about outliving a command:
 * a transient service where systemd can be reached, and where it can't,
 * as in the fence or the strict sandbox, that nothing the agent runs can.
 */
export function outlivingIt(kind: Sandbox["kind"]): string {
	if (kind === "fence" || kind === "strict") {
		return "Here no command can reach systemd to start what would outlive it, so something meant to outlive its command needs a service its owner runs, or the person.";
	}
	return 'To outlive both, start it as a transient service, which carries none: `systemd-run --user --unit=NAME --collect --same-dir --expand-environment=no --setenv=PATH="$PATH" --setenv=HOME="$HOME" --setenv=TMPDIR="$TMPDIR" --setenv=GIT_ASKPASS= --setenv=SSH_ASKPASS= --setenv=SSH_ASKPASS_REQUIRE=never -p RuntimeMaxSec=SECONDS -- bash -c \'COMMAND > LOG 2>&1; echo rc=$? >> LOG\'`, with a NAME of its own each run. It starts with none of the command\'s environment but what --setenv passes, so pass each variable the run needs, but never a secret, which systemd keeps in the unit\'s record: have the command read that from its file. `systemctl --user status NAME` says how it runs, `systemctl --user stop NAME` stops it, and `journalctl --user -u NAME` says how it ended.';
}
