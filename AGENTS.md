# AGENTS.md

Project notes for cmd-center.

## Read these first

- `ARCHITECTURE.md` in this directory: the codebase map, data flow, and the
  decisions that look wrong until you know why. Read it before searching the
  tree.
- `CLAUDE.md` in this directory: anything specific to this project.

## Operating rules

The full rules are in the `michael-rules` block of your own global agent file,
copied there from `~/.claude/CLAUDE.md` by
`~/repo/claude/templates/sync-agent-rules.sh`:

    Codex      ~/.codex/AGENTS.md
    Gemini     ~/.gemini/GEMINI.md
    opencode   ~/.config/opencode/AGENTS.md
    Claude     ~/.claude/CLAUDE.md (loaded automatically)

If your tool reads none of those, the short version:

    act after checks pass
    use live evidence over stale memory
    keep state compact
    break no-action loops early
    save only lessons that change future behavior
    keep safety rails useful
    no em-dashes, no emojis in documentation
    give directions as numbered step-by-step lists
    summarize completed work clearly, using lists and tables
    stop and restart the app after code changes, then say you did
