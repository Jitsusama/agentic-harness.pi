/**
 * Public surface of the remote library.
 *
 * Naming a git remote to a person. Its own module for the reason
 * `lib/exec` is: both `lib/review` and `lib/work` show a remote in
 * their refusals, and neither owns the question of what a remote may
 * safely say.
 */

export { withoutCredentials } from "./name.js";
