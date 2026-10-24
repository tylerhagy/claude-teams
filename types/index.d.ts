export type Row = {
  id: string
  role: string
  task: string
  status: 'running' | 'done'
  note: string
}

export type ItemStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'dropped'
export type Item = { id: string; title: string; status: ItemStatus; who: string }
export type Action = { id: string; text: string }
export type LogLine = { t: number; text: string }
export type Tab = 'work' | 'agents' | 'actions' | 'log'

declare module 'claude-code' {
  interface PluginState {
    teams: {
      active: string | null
      isGated: boolean
      limit: number | null
      rows: Row[]
      brief: string
      items: Item[]
      actions: Action[]
      log: LogLine[]
      tab: Tab
      delivered: string
    }
  }
}
