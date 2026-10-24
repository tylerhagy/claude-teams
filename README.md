# claude-teams

A Claude Code mod for working with a team of agents on demand. You turn a team on with `/team`, your session becomes the team's lead, and the lead hands work to specialists. A pane beside the chat shows the plan, who is doing what, what needs you, and a log of what happened. Your ordinary prompts are untouched until you turn a team on.

It ships one example team, a design team (a lead and six specialists). Teams are plain markdown files, so you can edit that one or write your own, for example a team for management work.

## What it does

- **`/team <name>`** turns a team on: this session acts as the team's lead and the specialists become available to delegate to. **`/team off`** turns it off.
- **A pane** (`/team` opens it) with the team's folder at the top, whether the team is active, a two-sentence status, and four tabs:
  - **Work:** the plan as a plain-language list with a status symbol on the left (○ not started, ◐ in progress, ● done, ! blocked, ⊘ dropped). You can drop or restore an item, or clear the plan.
  - **Agents:** which specialist is working on what, and its latest step.
  - **Needs You:** things you have to decide or do, each with a Done button. A toast appears when one arrives.
  - **Log:** a time-stamped history: helpers started and finished, plan updates, blocked actions, your own changes.
- **Controls in the pane:** Turn Off / Turn On, and a helper limit with − and +, No Limit, and a field that takes any number.
- **Guardrails on specialists,** enforced by the mod rather than only asked for in their instructions:
  - a helper limit you set (none by default), and an optional approval prompt before each helper starts (`/team gate on`);
  - helpers cannot call tools that create, edit or send things in connected systems (wikis, trackers, chat, email); the lead can, when you ask;
  - per-specialist limits you declare in the member file (below).
- **Saved between sessions,** per team: the status, plan, actions and log. `/team clear` resets them.

## How it works

The lead is told, through a small tool (`team_update`), to keep the pane current: a status brief, the plan as a list, and anything it needs from you. The Agents tab and the Log fill in on their own from what actually runs. Because the brief, plan and actions come from the model, they can be stale or wrong sometimes; the Agents tab and Log are the reliable record.

## Requirements

- Claude Code with mods (plugins with a hooks module).
- A terminal wide enough for a pane (about 110 columns).
- Tested in the Claude Code terminal only.

## Install

```
/plugin install teams --marketplace tylerhagy/claude-teams
```

Then copy the example team into the folder the mod reads (`~/.claude/teams` by default):

```
git clone https://github.com/tylerhagy/claude-teams
mkdir -p ~/.claude/teams
cp -r claude-teams/teams/design ~/.claude/teams/
```

Or leave the example where it is and point the mod's **Teams folder** option at the repo's `teams` folder. Then run `/team design`.

## Writing a team

A team is a folder with a lead and a `members` folder:

```
~/.claude/teams/<team>/
  team.md              the lead's instructions
  shared.md            rules for everyone (optional)
  members/<id>.md      one file per specialist
```

Each file is markdown with a short header, then the instructions as plain text:

```
---
name: researcher
team: design
role: member
description: One line the lead reads when choosing who to delegate to.
disallowed_tools: Bash, Edit, NotebookEdit
code_edits: no
---

You are a Researcher. ...
```

- `name` is the id the lead delegates by. Name members in the lead's instructions by this id.
- `description` is what the lead sees when picking a specialist.
- `disallowed_tools` (optional) lists tools the specialist may not call.
- `code_edits: no` (optional) stops the specialist writing or editing code files (`.ts`, `.css`, `.html` and similar). It can still write notes.
- The lead's file (`team.md`) reaches the model as extra context beside your next prompt when the team is turned on, and again if it changes or after a compaction. It is never shown in the chat.
- `shared.md` (optional) holds rules that apply to everyone, such as who the person is and what never to publish. It is added to the lead's instructions and to the end of every specialist's, so each rule is written once.

The example files are the design team's instructions. They are written to be adapted: the intake questions, the routing table and the "never publish" rules are the parts to change for another kind of team.

## Commands

| Command | What it does |
| --- | --- |
| `/team` | List teams, show which is on, open the pane |
| `/team <name>` | Turn a team on |
| `/team off` | Turn the team off (running helpers finish) |
| `/team gate on` / `off` | Ask before each helper starts |
| `/team limit <n>` / `limit off` | Cap how many helpers run at once |
| `/team clear` | Clear the pane's status, plan, actions and log |

## Options

- **Teams folder:** where teams live. Empty means `~/.claude/teams`.

## Status

An early version. The guardrails block by tool name and file extension, so they are a good fence and not a guarantee: a tool with an unexpected name can slip through, and a blocked name can be a false alarm.

## License

MIT
