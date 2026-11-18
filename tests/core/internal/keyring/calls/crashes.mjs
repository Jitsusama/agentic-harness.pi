// A keyring call that dies by a signal before it answers, as the native module did with SIGSEGV on 18 November; SIGKILL stands in so no run leaves a core dump to write.
process.kill(process.pid, "SIGKILL");
