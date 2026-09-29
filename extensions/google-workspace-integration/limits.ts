/**
 * How long one read may take, across every request it makes.
 *
 * Core ends each request at two minutes, but a read can make several:
 * a thread, a document export, a calendar sweep across people. Five
 * minutes is well past any of those answering and short of a call that
 * holds the session for as long as Google stays quiet.
 */
export const GOOGLE_READ_WALL_MS = 5 * 60_000;
