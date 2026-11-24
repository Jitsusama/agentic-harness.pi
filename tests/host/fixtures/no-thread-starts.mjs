// Preloaded by threads-as-source.test.ts so every thread dies as it starts.
//
// A thread takes its process's flags, this `--import` among them, so a
// thread's first line throws here as the checkpoint thread's and the hold
// watch's `require` did under a host started as module source, while the
// main thread runs on.
import { isMainThread } from "node:worker_threads";

if (!isMainThread) {
	throw new Error("no thread may start in this process");
}
