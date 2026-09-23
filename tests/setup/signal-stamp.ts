/**
 * Take the quest workflow's signal listeners back out after every
 * test.
 *
 * Loading a quest starts listening for SIGHUP and SIGTERM, so a
 * session its terminal takes away can be told from one the user quit.
 * In a vitest worker that listener would outlive the test that loaded
 * the quest, and a listener present when the pool sends its teardown
 * SIGTERM switches off the default exit: the worker would then linger
 * until the stamp's re-raise fired, seconds later. Removing it here
 * covers every suite that loads a quest, including the ones nobody
 * has written yet.
 */

import { afterEach } from "vitest";
import {
	removeSignalStamp,
	setSignalStampSession,
} from "../../extensions/quest-workflow/session-registry";

afterEach(() => {
	removeSignalStamp();
	setSignalStampSession(undefined);
});
