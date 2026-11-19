// A keyring call that says why on stderr and dies by a signal before it answers, as the native module did with SIGSEGV on 18 November; SIGKILL stands in so no run leaves a core dump to write.
process.stderr.write(
	"thread '<unnamed>' panicked at the entry\nError: the entry faulted\nNode.js v22\n",
);
process.kill(process.pid, "SIGKILL");
