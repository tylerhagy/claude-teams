import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Action, Item, ItemStatus, LogLine, Row } from '../types'

const PANE = 'team-feed'

const active = atom({ plugin: 'teams', key: 'active' } as const, null)
// null: no limit on how many helpers run at once. /team limit <n> sets one.
const limit = atom({ plugin: 'teams', key: 'limit' } as const, null)
const isGated = atom({ plugin: 'teams', key: 'isGated' } as const, false)
const rows = atom({ plugin: 'teams', key: 'rows' } as const, [])
// What the lead reports into the pane (team_update), kept per team between sessions.
const brief = atom({ plugin: 'teams', key: 'brief' } as const, '')
const items = atom({ plugin: 'teams', key: 'items' } as const, [])
const actions = atom({ plugin: 'teams', key: 'actions' } as const, [])
const log = atom({ plugin: 'teams', key: 'log' } as const, [])
// Which version of the lead's instructions the conversation already holds.
const delivered = atom({ plugin: 'teams', key: 'delivered' } as const, '')
const tab = atom({ plugin: 'teams', key: 'tab' } as const, 'work')

type Member = {
  name: string
  description: string
  prompt: string
  disallowedTools: string[]
  isNoCodeEdits: boolean
}
type Team = {
  name: string
  lead: string
  leadName: string
  leadDescription: string
  // rules for everyone, from shared.md next to team.md (optional)
  shared: string
  members: Member[]
}
type Color = 'green' | 'yellow' | 'red' | undefined

// Limits a team's member files declare in their frontmatter:
//   disallowed_tools: Bash, Edit     tools the member may not call
//   code_edits: no                   the member writes notes and drafts, not code files
const CODE_FILE = /\.(jsx?|tsx?|css|scss|html?|vue|svelte|py|sh)$/i
// Any connected tool whose name says it creates, changes or sends something.
const EXTERNAL_WRITE =
  /(^|_)(create|edit|update|add|transition|delete|write|send|post|publish|upload|reply|comment)|^trelloWrite|use_figma|html_to_figma|generate_figma|generate_image|executeWrite|executeDestructive/i

const ITEM_STATUSES: ItemStatus[] = ['todo', 'doing', 'done', 'blocked', 'dropped']
const MARKS: Record<ItemStatus, { mark: string; color: Color }> = {
  todo: { mark: '○', color: undefined },
  doing: { mark: '◐', color: 'yellow' },
  done: { mark: '●', color: 'green' },
  blocked: { mark: '!', color: 'red' },
  dropped: { mark: '⊘', color: undefined },
}

const UPDATE_TOOL = {
  name: 'team_update',
  description:
    'Keep the team pane the person sees up to date. Call it when a plan is approved or changes, when work moves forward, and when you need the person to do or decide something. Never needed for chat replies. Fields are all optional: send only what changed, but always send the whole items list.',
  inputSchema: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description:
          'Where things stand and what is being worked on now, in two sentences or fewer, plain language.',
      },
      items: {
        type: 'array',
        description:
          'The plan as 3 to 8 plain-language things the team is digging into. Replaces the whole list.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable short id, e.g. "1".' },
            title: { type: 'string', description: 'Plain words, under 60 characters.' },
            status: { type: 'string', enum: ITEM_STATUSES },
            who: { type: 'string', description: 'Specialist id working on it, if any.' },
          },
          required: ['id', 'title', 'status'],
        },
      },
      addActions: {
        type: 'array',
        description:
          'Things the person needs to decide or do themselves, one short sentence each.',
        items: { type: 'string' },
      },
      doneActions: {
        type: 'array',
        description: 'Ids of actions that no longer need the person (shown when you add them).',
        items: { type: 'string' },
      },
    },
  },
  isDeferred: false,
}

const splitFrontmatter = (text: string) => {
  const meta: Record<string, string> = {}
  if (!text.startsWith('---\n')) return { meta, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { meta, body: text }
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: text.slice(end + 5).replace(/^\n+/, '') }
}

const firstSentences = (text: string, n = 2) => text.trim().split(/(?<=[.!?])\s+/).slice(0, n).join(' ')

const clock = (t: number) => new Date(t).toTimeString().slice(0, 5)

let loaded: Team | null = null
// The teams folder the person set in the mod's options; empty means ~/.claude/teams.
let configuredDir = ''

const teamsDir = async ($: any): Promise<string> => {
  const home = ((await $.env.get('HOME')) as string | undefined) ?? ''
  const dir = configuredDir.trim() === '' ? '~/.claude/teams' : configuredDir.trim()
  return dir.startsWith('~') ? `${home}${dir.slice(1)}` : dir
}

const prefix = ($: { plugin: { name: string } }) => `${$.plugin.name}:`

const loadTeam = async ($: any, name: string): Promise<Team> => {
  const dir = `${await teamsDir($)}/${name}`
  const leadFile = splitFrontmatter(await $.fs.read(`${dir}/team.md`))
  const lead = leadFile.body
  const files = (await $.fs.list(`${dir}/members`)) as { name: string }[]
  const members: Member[] = []
  for (const file of files.filter(f => f.name.endsWith('.md'))) {
    const { meta, body } = splitFrontmatter(
      await $.fs.read(`${dir}/members/${file.name}`),
    )
    const id = meta.name ?? file.name.replace(/\.md$/, '')
    members.push({
      name: id,
      description: meta.description ?? id,
      prompt: body,
      disallowedTools: (meta.disallowed_tools ?? '')
        .split(',')
        .map(tool => tool.trim())
        .filter(tool => tool !== ''),
      isNoCodeEdits: (meta.code_edits ?? '').toLowerCase() === 'no',
    })
  }
  const shared = (await $.fs.exists(`${dir}/shared.md`)) ? ((await $.fs.read(`${dir}/shared.md`)) as string).trim() : ''
  return {
    name,
    lead,
    shared,
    leadName: leadFile.meta.name ?? `${name}-lead`,
    leadDescription: leadFile.meta.description ?? '',
    members,
  }
}

const registerMembers = async ($: any, team: Team) => {
  for (const member of team.members) {
    await $.agent.register({
      name: member.name,
      description: member.description,
      prompt: team.shared === '' ? member.prompt : `${member.prompt.trimEnd()}\n\n${team.shared}`,
      disallowedTools: member.disallowedTools.length > 0 ? member.disallowedTools : undefined,
    })
  }
}

// The team the person turned on, loaded again if the module restarted.
const current = async ($: any): Promise<Team | null> => {
  const name = await read($, active)
  if (name === null) return null
  if (loaded?.name !== name) {
    loaded = await loadTeam($, name)
    await registerMembers($, loaded)
  }
  return loaded
}

const roleOf = async ($: any, agentId: string | undefined) => {
  if (agentId === undefined) return undefined
  const agents = await $.agent.list()
  const agent = agents.find((a: { id: string }) => a.id === agentId)
  return agent?.type.startsWith(prefix($))
    ? (agent.type.slice(prefix($).length) as string)
    : undefined
}

// The pane's own words (brief, plan, actions, log) outlive the session, per team.
const save = async ($: any) => {
  const team = await read($, active)
  if (team === null) return
  await $.store.set(`pane:${team}`, {
    brief: await read($, brief),
    items: await read($, items),
    actions: await read($, actions),
    log: await read($, log),
  })
}

const restore = async ($: any, team: string) => {
  const saved = (await $.store.get(`pane:${team}`)) as
    | { brief?: string; items?: Item[]; actions?: Action[]; log?: LogLine[] }
    | undefined
  await update($, brief, () => saved?.brief ?? '')
  await update($, items, () => saved?.items ?? [])
  await update($, actions, () => saved?.actions ?? [])
  await update($, log, () => saved?.log ?? [])
}

const note = async ($: any, text: string) => {
  const t = (await $.clock.now()) as number
  await update($, log, (list: LogLine[]) => [...list, { t, text }].slice(-100))
  await save($)
}

const setItemStatus = async ($: any, item: Item, status: ItemStatus) => {
  await update($, items, (list: Item[]) => list.map(i => (i.id === item.id ? { ...i, status } : i)))
  await note($, status === 'dropped' ? `You dropped: ${item.title}` : `You brought back: ${item.title}`)
}

const clearPlan = async ($: any) => {
  await update($, items, () => [])
  await note($, 'You cleared the plan')
}

const finishAction = async ($: any, action: Action) => {
  await update($, actions, (list: Action[]) => list.filter(a => a.id !== action.id))
  await note($, `You finished: ${action.text}`)
}

const turnOn = async ($: any, name: string): Promise<string> => {
  const root = await teamsDir($)
  if (!(await $.fs.exists(`${root}/${name}/team.md`))) {
    return `No team called "${name}" in ${root}.`
  }
  loaded = await loadTeam($, name)
  await registerMembers($, loaded)
  await update($, active, () => name)
  await update($, delivered, () => '')
  await update($, rows, () => [])
  await restore($, name)
  await note($, `Team turned on: ${name}`)
  void $.ui.open({ id: PANE, title: 'Team' })
  const names = loaded.members.map(m => m.name).join(', ')
  const max = await read($, limit)
  return `${name} team on. Lead: this session. Specialists: ${names}. ${max === null ? 'No helper limit.' : `Max ${max} running at once.`}`
}

const turnOff = async ($: any) => {
  await note($, 'Team turned off')
  await update($, active, () => null)
  await update($, delivered, () => '')
  loaded = null
}

const setLimit = async ($: any, next: number | null) => {
  await update($, limit, () => next)
  await note($, next === null ? 'Helper limit removed' : `Helper limit set to ${next}`)
}

// From the pane's number field: a whole number of 1 or more, or nothing/"none" for no limit.
const setLimitFromText = async ($: any, text: string) => {
  const word = text.trim().toLowerCase()
  if (/^[1-9]\d*$/.test(word)) return setLimit($, Number(word))
  if (word === '' || word === 'none' || word === 'off' || word === 'no limit') return setLimit($, null)
}

// What the lead is told when a team is on: its own file, how to delegate, and how to fill the pane.
const leadText = async ($: any, team: Team): Promise<string> => {
  const ids = team.members
    .map(m => `${m.name} (subagent_type "${prefix($)}${m.name}")`)
    .join(', ')
  const max = await read($, limit)
  return [
    `The person turned on the "${team.name}" team with /team. For this conversation you are the lead described below.`,
    `Delegate with the Agent tool to these specialists: ${ids}. Where the instructions name a specialist by id, use its subagent_type here.`,
    max === null
      ? 'The person has set no limit on how many specialists run at once, so ignore any helper limit written in the instructions below. They can set one with /team limit.'
      : `The system allows at most ${max} specialists running at once, so ignore any other helper limit written in the instructions below. It may also ask the person before one starts.`,
    'The person watches a team pane. Keep it current with the team_update tool (mcp__teams__team_update), without mentioning the tool in chat:',
    '- brief: where things stand and what is being worked on now, two sentences or fewer, plain words.',
    '- items: once a plan is approved, the plan as 3 to 8 plain-language things the team is digging into, each with a status (todo, doing, done, blocked) and the specialist working it. Send the whole list each time and update statuses as work moves.',
    '- Items the person dropped (status dropped) stay dropped: leave them in the list and do not bring them back or work on them.',
    '- addActions: anything the person must decide or do themselves (approvals, answers, things to paste or send), one short sentence each. Add one the moment you ask for it.',
    '',
    team.lead,
    ...(team.shared === '' ? [] : ['', team.shared]),
  ].join('\n')
}

const hashOf = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

export const register: Register = (on, options) => {
  configuredDir = typeof options.teamsDir === 'string' ? options.teamsDir : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'team',
      description: 'Turn a team of agents on or off, or see what they are doing',
      argumentHint: '[<team> | off | gate on | gate off | limit <n> | limit off | clear]',
    })
    await $.tool.register(UPDATE_TOOL)
    await current($)
    return next(e)
  })

  on('command.run', { command: 'team' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'off') {
      await turnOff($)
      return { text: 'Team off. Your prompts go to the main session again.' }
    }

    if (arg === 'clear') {
      await update($, brief, () => '')
      await update($, items, () => [])
      await update($, actions, () => [])
      await update($, log, () => [])
      await save($)
      return { text: 'Cleared the pane: status, plan, actions and log.' }
    }

    if (arg === 'gate on' || arg === 'gate off') {
      await update($, isGated, () => arg === 'gate on')
      await note($, arg === 'gate on' ? 'Spawn approval turned on' : 'Spawn approval turned off')
      return {
        text:
          arg === 'gate on'
            ? 'Spawn approval on: you will be asked before each helper starts.'
            : 'Spawn approval off.',
      }
    }

    const limitArg = /^limit\s+(\d+|off)$/.exec(arg)
    if (limitArg !== null) {
      const next = limitArg[1] === 'off' ? null : Number(limitArg[1])
      if (next === 0) return { text: 'A limit of 0 would block every helper. Use /team limit off for no limit.' }
      await setLimit($, next)
      return {
        text:
          next === null
            ? 'No helper limit. Any number can run at once.'
            : `Helper limit: ${next} running at once. A further helper is refused until one finishes.`,
      }
    }

    if (arg === '' || arg === 'status') {
      const entries = (await $.fs.list(await teamsDir($))) as {
        name: string
        kind: string
      }[]
      const names = entries
        .filter(entry => entry.kind === 'dir')
        .map(entry => entry.name)
      const now = await read($, active)
      void $.ui.open({ id: PANE, title: 'Team' })
      return {
        text: `Teams: ${names.join(', ') || 'none found'}. On now: ${now ?? 'none'}. Use /team <name> or /team off.`,
      }
    }

    return { text: await turnOn($, arg) }
  })

  // The lead's instructions ride beside the prompt as context (the person never sees it). They go once
  // when a team is turned on, again if they change or after a compaction, not on every prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    const team = await current($)
    if (team === null) return next(e)
    const text = await leadText($, team)
    const stamp = `${team.name}:${hashOf(text)}`
    if ((await read($, delivered)) === stamp) return next(e)
    await update($, delivered, () => stamp)
    return next({ ...e, context: [...(e.context ?? []), text] })
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger !== 'precompute') await update($, delivered, () => '')
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    if (!e.agent.startsWith(prefix($))) return next(e)
    const team = await current($)
    const isOn = team?.members.some(m => `${prefix($)}${m.name}` === e.agent)
    return isOn ? next(e) : { isOffered: false }
  }).catch(() => ({ isOffered: false }))

  on('agent.spawn', async ($, e, next) => {
    if (!e.subagentType.startsWith(prefix($))) return next(e)
    const role = e.subagentType.slice(prefix($).length)

    const agents = await $.agent.list()
    const live = agents.filter(
      a =>
        a.type.startsWith(prefix($)) &&
        ['pending', 'running', 'waiting'].includes(a.status),
    )
    const max = await read($, limit)
    if (max !== null && live.length >= max) {
      const who = live.map(a => a.type.slice(prefix($).length)).join(', ')
      await note($, `Held back ${role}: limit of ${max} reached`)
      return {
        deny: `The person's helper limit of ${max} is reached (${who} running). Ask the person what to pause before starting ${role}.`,
      }
    }

    if (await read($, isGated)) {
      const choice = await $.ui
        .ask(`Start ${role} on "${e.description}"?`, ['Yes', 'No'])
        .catch(() => 'No')
      if (choice !== 'Yes') {
        await note($, `You declined to start ${role}`)
        return { deny: `The person did not approve starting ${role}.` }
      }
    }

    const started = await next(e)
    if (started.deny === undefined && started.agentId !== undefined) {
      const row: Row = {
        id: started.agentId,
        role,
        task: e.description,
        status: 'running',
        note: 'starting',
      }
      await update($, rows, list => [...list, row].slice(-30))
      await note($, `Started ${role}: ${e.description}`)
    }
    return started
  }).catch(($, e, next) =>
    !e.subagentType.startsWith(prefix($)) || next.called
      ? next(e)
      : { deny: 'teams: could not check the helper limit, so the helper was not started.' },
  )

  // The lead's way of filling the pane: brief, plan list, things the person must do.
  on('tool.call', { tool: 'mcp__teams__team_update' }, async ($, e) => {
    const team = await read($, active)
    if (team === null) {
      return { result: 'No team is on, so there is no pane to update. The person can turn one on with /team.' }
    }
    const input = e as unknown as {
      brief?: string
      items?: { id?: string; title?: string; status?: string; who?: string }[]
      addActions?: string[]
      doneActions?: string[]
    }

    if (typeof input.brief === 'string') {
      const text = input.brief.trim()
      await update($, brief, () => text)
    }

    if (Array.isArray(input.items)) {
      const before = await read($, items)
      const droppedIds = new Set(before.filter(i => i.status === 'dropped').map(i => i.id))
      const next: Item[] = input.items
        .filter(i => i && typeof i.title === 'string' && i.title.trim() !== '')
        .slice(0, 12)
        .map((i, n) => ({
          id: String(i.id ?? n),
          title: (i.title ?? '').trim(),
          status: droppedIds.has(String(i.id ?? n))
            ? 'dropped'
            : ITEM_STATUSES.includes(i.status as ItemStatus)
              ? (i.status as ItemStatus)
              : 'todo',
          who: (i.who ?? '').trim(),
        }))
      await update($, items, () => next)
      await note($, `Plan updated: ${next.filter(i => i.status === 'done').length} of ${next.length} done`)
    }

    if (Array.isArray(input.doneActions) && input.doneActions.length > 0) {
      const gone = input.doneActions
      await update($, actions, list => list.filter(a => !gone.includes(a.id)))
      await note($, `Cleared ${gone.length} item(s) that no longer need you`)
    }

    if (Array.isArray(input.addActions)) {
      const t = (await $.clock.now()) as number
      const added: Action[] = input.addActions
        .filter(s => typeof s === 'string' && s.trim() !== '')
        .map((text, n) => ({ id: `a${(t % 1000000).toString(36)}${n}`, text: text.trim() }))
      if (added.length > 0) {
        await update($, actions, list => [...list, ...added])
        for (const action of added) await note($, `Needs you: ${action.text}`)
        $.ui.toast(
          added.length === 1 ? `Needs you: ${added[0].text}` : `${added.length} new things need you`,
        )
      }
    }

    await save($)
    const open = await read($, actions)
    return {
      result: `Pane updated. Open actions for the person: ${open.map(a => `[${a.id}] ${a.text}`).join('; ') || 'none'}.`,
    }
  }).catch(() => ({ result: 'The pane could not be updated this time.' }))

  on('tool.call', async ($, e, next) => {
    const role = await roleOf($, e.agentId)
    if (role === undefined) return next(e)

    if (e.tool.startsWith('mcp__') && EXTERNAL_WRITE.test(e.tool.split('__').pop() ?? '')) {
      await note($, `Blocked ${role} from changing a shared system (${e.tool.split('__').pop()})`)
      return {
        deny: `${role} cannot change or send anything in a shared system. Hand the draft to the lead for the person to publish.`,
      }
    }
    if (
      (await current($))?.members.find(m => m.name === role)?.isNoCodeEdits === true &&
      (e.tool === 'Write' || e.tool === 'Edit') &&
      CODE_FILE.test(e.file_path)
    ) {
      await note($, `Blocked ${role} from editing a code file`)
      return {
        deny: `${role} writes notes and drafts, not code or prototype files (${e.file_path}).`,
      }
    }

    const id = e.agentId
    await update($, rows, list =>
      list.map(r => (r.id === id ? { ...r, note: e.tool.replace(/^mcp__/, '') } : r)),
    )
    return next(e)
  }).catch(($, e, next) =>
    e.agentId === undefined || next.called
      ? next(e)
      : { deny: 'teams: could not check this call for a team helper, so it was refused.' },
  )

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const summary = e.answer.replace(/\s+/g, ' ').slice(0, 140)
      const before = (await read($, rows)).find(r => r.id === id)
      await update($, rows, list =>
        list.map(r => (r.id === id ? { ...r, status: 'done' as const, note: summary } : r)),
      )
      if (before?.status === 'running') {
        await note($, `${before.role} finished: ${summary.slice(0, 100)}`)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Phones draw no text field yet; the +/- buttons still work there.
    const Input = 'Input' in els ? els.Input : null
    const team = await read($, active)
    const max = await read($, limit)
    const agents = await read($, rows)
    const summary = await read($, brief)
    const plan = await read($, items)
    const todo = await read($, actions)
    const history = await read($, log)
    const view = await read($, tab)
    const roster = team === null ? null : loaded?.name === team ? loaded : await current($)
    const root = await teamsDir($)
    const entries = (await $.fs.list(root).catch(() => [])) as { name: string; kind: string }[]
    const teamNames = entries.filter(entry => entry.kind === 'dir').map(entry => entry.name)
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 18)
    const spaced = Math.max(1, Math.floor(room / 2))
    const working = agents.filter(r => r.status === 'running').length
    const tabs = [
      { key: 'work', label: 'Work' },
      { key: 'agents', label: 'Team' },
      { key: 'actions', label: todo.length > 0 ? `Needs You (${todo.length})` : 'Needs You' },
      { key: 'log', label: 'Log' },
    ] as const
    const more = (shown: number, total: number) =>
      total > shown ? <Text dimColor>+{total - shown} more. Make the pane taller to see them.</Text> : null

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor wrap="wrap">
          {team === null ? root : `${root}/${team}`}
        </Text>

        {team === null && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>○ No team on. Type /team &lt;name&gt; or press a button.</Text>
            {teamNames.length > 0 && (
              <Box gap={1}>
                {teamNames.map(name => (
                  <Button
                    key={`on-${name}`}
                    variant="primary"
                    label={`Turn On ${name}`}
                    onPress={() => void turnOn($, name)}
                  />
                ))}
              </Box>
            )}
          </Box>
        )}

        {team !== null && (
          <Box flexDirection="column" gap={1}>
            <Box justifyContent="space-between">
              <Box flexDirection="column" flexShrink={1}>
                <Text color="green" bold>● {team} team: active</Text>
                <Text dimColor wrap="wrap">
                  {working > 0 ? `${working} helper${working === 1 ? '' : 's'} working` : 'No helpers running'}
                </Text>
              </Box>
              <Box flexShrink={0} paddingLeft={2}>
                <Button key="team-off" label="Turn Off" onPress={() => void turnOff($)} />
              </Box>
            </Box>

            <Text wrap="wrap">
              {summary !== '' ? summary : 'No status yet. The lead fills this in once there is work.'}
            </Text>

            <Box flexDirection="column">
              <Box gap={1}>
                <Text>Helpers at once:</Text>
                {max === null ? (
                  <Text bold>no limit</Text>
                ) : (
                  <Text bold>{max}</Text>
                )}
              </Box>
              <Box gap={1}>
                {max !== null && (
                  <Button key="limit-down" label="−" onPress={() => void setLimit($, Math.max(1, max - 1))} />
                )}
                {max !== null && (
                  <Button key="limit-up" label="+" onPress={() => void setLimit($, max + 1)} />
                )}
                {max === null ? (
                  <Button key="limit-set" label="Set a Limit" onPress={() => void setLimit($, Math.max(1, working))} />
                ) : (
                  <Button key="limit-none" label="No Limit" onPress={() => void setLimit($, null)} />
                )}
              </Box>
              {Input !== null && (
                <Input
                  key="limit-input"
                  label="Or type a number (or none)"
                  placeholder="3"
                  onSubmit={(value: string) => void setLimitFromText($, value)}
                />
              )}
            </Box>

            <Box gap={1}>
              {tabs.map(t => (
                <Button
                  key={`tab-${t.key}`}
                  plain
                  label={t.label}
                  onPress={() => update($, tab, () => t.key)}
                >
                  {view === t.key ? (
                    <Text inverse bold> {t.label} </Text>
                  ) : (
                    <Text dimColor> {t.label} </Text>
                  )}
                </Button>
              ))}
            </Box>

            {view === 'work' && (
              <Box flexDirection="column" gap={1}>
                {plan.length === 0 && (
                  <Text dimColor wrap="wrap">
                    No plan yet. The lead lists what the team is digging into once there is one.
                  </Text>
                )}
                {plan.slice(0, spaced).map(item => (
                  <Box key={`item-${item.id}`}>
                    <Box width={2} flexShrink={0}>
                      <Text color={MARKS[item.status].color}>{MARKS[item.status].mark}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="wrap" dimColor={item.status === 'done' || item.status === 'dropped'}>
                        {item.title}
                        {item.who !== '' ? <Text dimColor> · {item.who}</Text> : null}
                      </Text>
                    </Box>
                    <Box flexShrink={0} paddingLeft={1}>
                      {item.status === 'dropped' ? (
                        <Button
                          key={`undo-${item.id}`}
                          label="Undo"
                          onPress={() => void setItemStatus($, item, 'todo')}
                        />
                      ) : item.status !== 'done' ? (
                        <Button
                          key={`drop-${item.id}`}
                          label="Drop"
                          onPress={() => void setItemStatus($, item, 'dropped')}
                        />
                      ) : null}
                    </Box>
                  </Box>
                ))}
                {more(spaced, plan.length)}
                {plan.length > 0 && (
                  <Text dimColor wrap="wrap">○ not started   ◐ in progress   ● done   ! blocked   ⊘ dropped</Text>
                )}
                {plan.length > 0 && (
                  <Box>
                    <Button key="plan-clear" label="Clear Plan" onPress={() => void clearPlan($)} />
                  </Box>
                )}
              </Box>
            )}

            {view === 'agents' && roster !== null && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column">
                  <Box>
                    <Box width={2} flexShrink={0}>
                      <Text color="green">●</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="wrap">
                        <Text bold>{roster.leadName}</Text>
                        <Text dimColor> · lead · this session</Text>
                      </Text>
                    </Box>
                  </Box>
                  <Box paddingLeft={2} flexDirection="column">
                    {roster.leadDescription !== '' && (
                      <Text dimColor wrap="wrap">{firstSentences(roster.leadDescription)}</Text>
                    )}
                    {summary !== '' && <Text wrap="wrap">now: {summary}</Text>}
                  </Box>
                </Box>
                <Box flexDirection="column" paddingLeft={2} gap={1}>
                  {roster.members.map((m, i) => {
                    const mine = agents.filter(r => r.role === m.name)
                    const running = mine.filter(r => r.status === 'running')
                    const last = [...mine].reverse().find(r => r.status === 'done')
                    const planned = plan.filter(
                      p => p.who === m.name && ['doing', 'blocked', 'todo'].includes(p.status),
                    )
                    const state = running.length > 0 ? 'working' : last !== undefined ? 'finished' : 'idle'
                    return (
                      <Box key={`member-${m.name}`} flexDirection="column">
                        <Box>
                          <Box flexShrink={0}>
                            <Text dimColor>{i === roster.members.length - 1 ? '└─' : '├─'}</Text>
                          </Box>
                          <Box width={3} flexShrink={0} paddingLeft={1}>
                            <Text color={state === 'working' ? 'yellow' : state === 'finished' ? 'green' : undefined} dimColor={state === 'idle'}>
                              {state === 'working' ? '◐' : state === 'finished' ? '●' : '○'}
                            </Text>
                          </Box>
                          <Box flexGrow={1} flexShrink={1}>
                            <Text wrap="wrap">
                              <Text bold>{m.name}</Text>
                              <Text dimColor>
                                {' · '}
                                {state === 'working' && running.length > 1 ? `working (${running.length} runs)` : state}
                              </Text>
                            </Text>
                          </Box>
                        </Box>
                        <Box paddingLeft={5} flexDirection="column">
                          <Text dimColor wrap="wrap">{firstSentences(m.description)}</Text>
                          {running.map(r => (
                            <Text key={`on-${r.id}`} color="yellow" wrap="wrap">on: {r.task}</Text>
                          ))}
                          {running.length === 0 && last !== undefined && (
                            <Text dimColor wrap="wrap">last: {last.task}</Text>
                          )}
                          {planned.map(p => (
                            <Text key={`plan-${p.id}`} wrap="wrap" color={MARKS[p.status].color}>
                              {MARKS[p.status].mark} {p.title}
                            </Text>
                          ))}
                        </Box>
                      </Box>
                    )
                  })}
                </Box>
              </Box>
            )}

            {view === 'actions' && (
              <Box flexDirection="column" gap={1}>
                {todo.length === 0 && <Text dimColor>Nothing needs you right now.</Text>}
                {todo.slice(0, spaced).map(action => (
                  <Box key={`action-${action.id}`} justifyContent="space-between">
                    <Box flexGrow={1} flexShrink={1} paddingRight={1}>
                      <Text color="yellow" wrap="wrap">→ {action.text}</Text>
                    </Box>
                    <Box flexShrink={0}>
                      <Button
                        key={`done-${action.id}`}
                        label="Done"
                        onPress={() => void finishAction($, action)}
                      />
                    </Box>
                  </Box>
                ))}
                {more(spaced, todo.length)}
              </Box>
            )}

            {view === 'log' && (
              <Box flexDirection="column">
                {history.length === 0 && <Text dimColor>Nothing has happened yet.</Text>}
                {[...history].reverse().slice(0, room).map((line, n) => (
                  <Box key={`log-${line.t}-${n}`}>
                    <Box width={7} flexShrink={0}>
                      <Text dimColor>{clock(line.t)}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="wrap">{line.text}</Text>
                    </Box>
                  </Box>
                ))}
                {more(Math.min(room, history.length), history.length)}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
