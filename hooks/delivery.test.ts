import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const TEAM = '---\nname: lead\nteam: t\nrole: lead\ndescription: Leads.\n---\nLEAD BODY'
const SHARED = '## Ground rules\n- SHARED RULE'
const MEMBER = '---\nname: ann\nteam: t\nrole: member\ndescription: Ann does things.\n---\nANN BODY'

// The prompts handed to the engine for each specialist.
let registered: string[] = []

// A prompt as the composer sends it.
const say = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

// Nothing sits beneath the plugin: each `on` here stands for the engine.
const engine = (on: On) => {
  registered = []
  on('env.get', () => ({ value: '/home' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('team.md') ? TEAM : e.path.endsWith('shared.md') ? SHARED : MEMBER,
  }))
  on('fs.list', () => ({ value: [{ name: 'ann.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('agent.register', (_, e) => {
    registered.push(String((e as { prompt?: string }).prompt ?? ''))
    return { value: { agent: 'ann' } } as never
  })
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: 1 }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('session.compact', (_, e) => ({ messages: e.messages }) as never)
}

const turnOn = ($: { command: { run: (input: never) => Promise<unknown> } }) =>
  $.command.run({ command: 'team', args: 't' } as never)

test('the lead instructions ride beside the prompt once, not on every prompt', async ($, on) => {
  engine(on)
  await turnOn($)

  const first = await $.prompt.submit(say('one'))
  const second = await $.prompt.submit(say('two'))

  expect(first.context?.join('\n')).toContain('LEAD BODY')
  expect(first.context?.join('\n')).toContain('teams:ann')
  expect(second.context ?? []).toEqual([])
})

test('no team on, nothing is added', async ($, on) => {
  engine(on)

  const sent = await $.prompt.submit(say('one'))

  expect(sent.context ?? []).toEqual([])
})

test('after a compaction the lead instructions come again, once', async ($, on) => {
  engine(on)
  await turnOn($)

  await $.prompt.submit(say('one'))
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user', text: 'earlier', toolUses: [] }],
  } as never)
  const after = await $.prompt.submit(say('two'))
  const next = await $.prompt.submit(say('three'))

  expect(after.context?.join('\n')).toContain('LEAD BODY')
  expect(next.context ?? []).toEqual([])
})

test('the shared rules reach the lead and every specialist, once each', async ($, on) => {
  engine(on)
  await turnOn($)

  const first = await $.prompt.submit(say('one'))

  expect(first.context?.join('\n')).toContain('SHARED RULE')
  expect(registered).toHaveLength(1)
  expect(registered[0]).toContain('ANN BODY')
  expect(registered[0]).toContain('SHARED RULE')
  expect(registered[0]?.split('SHARED RULE').length).toBe(2)
})
