# Library

Common components used across extensions, organized by domain
into subdirectories for UI primitives, guardian pipeline logic,
command parsing and session state management.

UI primitives have no domain knowledge. Guardian and parse
modules depend on UI, not the other way around.
