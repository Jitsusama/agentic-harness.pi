# Test Helpers

Helpers tests across the package share: waiting on a condition rather than
sleeping, asking about real processes, a fake for running commands, a watch
over the child processes this process starts and whether each held the
loop, a fake pi for handing to an extension, a throwaway git repository per test, a stub
review provider, a runtime of its own for job-workflow, and a two-session
host for conversation isolation tests.
