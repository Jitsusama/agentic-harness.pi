// A keyring call that dies by a signal before it answers and says nothing on stderr, as a native fault that kills the process at once does; SIGKILL stands in for SIGSEGV so no run leaves a core dump to write.
process.kill(process.pid, "SIGKILL");
