export type DoomscrollItem = {
  id: string
  url: string
  author: string
  name: string
  desc: string
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  views: number | null
  music: string
  duration: number | null
}

export type DoomscrollPoster = { file: string; width: number; height: number; generation: number }

export type DoomscrollStatus = 'starting' | 'warming' | 'loading' | 'playing' | 'paused' | 'empty'

export type DoomscrollView = {
  status: DoomscrollStatus
  index: number
  total: number
  item: DoomscrollItem | null
  muted: boolean
  watched: number
  message: string | null
  poster: DoomscrollPoster | null
  ahead: number
  cell: { cw: number; ch: number } | null
  /** The terminal's background colour (#rrggbb), when the daemon could read it. */
  bg?: string | null
  term: { rows: number; cols: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    doomscroll: {
      view: DoomscrollView
      isWorking: boolean
      isSnoozed: boolean
      isHeld: boolean
      isUserPaused: boolean
      isDone: boolean
      liked: string[]
    }
  }
}
