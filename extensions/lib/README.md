# Library

Common components shared across extensions, organized by
domain into subdirectories for UI primitives, guardian pipeline
logic, command parsing and session state management.

UI primitives don't have any domain knowledge. Guardian and
parse modules depend on UI, not the other way around.
