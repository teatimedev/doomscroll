import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { DoomscrollView } from '../types'

const ITEM = {
  id: '7691740195418377502',
  url: 'https://www.tiktok.com/@khaby.lame/video/7691740195418377502',
  author: 'khaby.lame',
  name: 'Khabane lame',
  desc: 'Just give me 5 more minutes #learnfromkhaby #comedy',
  likes: 292200,
  comments: 4923,
  shares: 19700,
  saves: 13300,
  views: 2400000,
  music: 'original sound - Khabane lame',
  duration: 34,
}

const READY: DoomscrollView = {
  status: 'paused',
  index: 0,
  total: 12,
  item: ITEM,
  muted: false,
  watched: 3,
  message: null,
  poster: null,
  ahead: 2,
  cell: { cw: 16, ch: 34.7 },
  term: { rows: 44, cols: 169 },
}

const PANE = {
  plugin: 'doomscroll',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'doomscroll',
  props: {
    title: 'For You',
    isFocused: true, // the controls (and their hotkeys) show while the pane holds the keys
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/**
 * Stands in for bin/doomscrolld.py: the spawned process prints what `say` queues,
 * and the socket answers each command by printing the state it leads to, the
 * way the daemon does.
 */
function fakeDaemon(on: On) {
  const queue: string[] = []
  let wake: (() => void) | null = null
  let state: DoomscrollView = READY
  const ops: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const stats = { spawns: 0 }
  let isPaneUp = false

  const say = (line: string) => {
    queue.push(line)
    wake?.()
    wake = null
  }

  mock.store(on)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('process.spawn', async function* () {
    stats.spawns += 1
    while (true) {
      while (queue.length > 0) yield { stream: 'stdout' as const, text: `${queue.shift()}\n` }
      await new Promise<void>(resolve => {
        wake = resolve
      })
    }
  })
  on('http.fetch', (_$, e) => {
    const body = JSON.parse(String(e.init?.body ?? '{}')) as { op: string }
    ops.push(body.op)
    if (body.op === 'play') state = { ...state, status: 'playing' }
    if (body.op === 'pause') state = { ...state, status: 'paused' }
    if (body.op === 'next') state = { ...state, status: 'playing', index: state.index + 1, watched: state.watched + 1 }
    say(`S ${JSON.stringify(state)}`)
    if (state.status === 'playing') say(`F shm /dsc-test-${ops.length} ${ops.length} 320 568 1.50 30.00`)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(state) } }
  })
  on('ui.panes', () => ({
    value: isPaneUp ? [{ id: 'doomscroll', title: 'For You', isShown: true, isFocused: false, isPlaced: true, plugin: 'doomscroll' }] : [],
  }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    isPaneUp = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    isPaneUp = false
    return { value: undefined }
  })
  on('ui.blit', () => ({ value: {} }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))

  say('R /tmp/doomscroll-test.sock')
  say(`S ${JSON.stringify(READY)}`)
  return { ops, toasts, opened, say, stats }
}

/** Polls `check` across round trips to the plugin until it holds. */
async function eventually($: Engine, check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await doomscroll($, 'creators')
  }
  throw new Error('never happened')
}

/** `/doomscroll <args>` as the person types it. */
function doomscroll($: Engine, args: string) {
  return $.command.run({
    command: 'doomscroll',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 169 },
  })
}

const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const TURN = { answer: 'done', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer' } as const

// Each act on a mounted drawing waits for the plugin's open daemon loop to
// settle, about half a second here, hence the longer budgets.
test('plays while Claude works, scrolls, and pauses when Claude is done', { timeoutMs: 20000 }, async ($, on) => {
  const daemon = fakeDaemon(on)
  await $.session.start(SESSION)
  await eventually($, () => daemon.ops.includes('pause')) // idle at start

  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  expect(daemon.opened).toContain('doomscroll')
  await eventually($, () => daemon.ops.includes('play'))

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Image', key: 'video-45x37' })).toBeDefined() // keyed by its size
  expect(await ui.find({ type: 'Raster', key: 'bar-45' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '@khaby.lame' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '292K' })).toBeDefined()

  // A swipe, and the frame it brings tells the daemon the box the pane drew.
  await ui.press({ key: 'next' })
  expect(daemon.ops).toContain('next')
  await eventually($, () => daemon.ops.includes('size'))

  daemon.ops.length = 0
  await $.turn.complete(TURN)
  expect(daemon.ops).toContain('pause')
  expect(daemon.toasts).toContain("Claude's done. Back to work.")
  await eventually($, async () => (await ui.find({ type: 'Text', text: "Claude's done. Back to work." })) !== undefined)
  expect(await ui.find({ type: 'Button', key: 'pause', text: '▶' })).toBeDefined()
  await ui.unmount()
})

test("a subagent's turn ending does not pause the video", async ($, on) => {
  const daemon = fakeDaemon(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await eventually($, () => daemon.ops.includes('play'))

  daemon.ops.length = 0
  await $.turn.complete({ ...TURN, turnId: 'sub', agentId: 'a1' })
  expect(daemon.ops).not.toContain('pause')
})

test('/doomscroll off keeps it shut until /doomscroll', async ($, on) => {
  const daemon = fakeDaemon(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const off = await doomscroll($, 'off')
  expect(off.text).toContain('off for this session')

  daemon.opened.length = 0
  await $.turn.complete(TURN)
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(daemon.opened).toEqual([])

  const { text } = await doomscroll($, '')
  expect(text).toContain('Doomscroll is open')
  expect(daemon.opened).toEqual(['doomscroll'])
})

test('liking a video counts it on the rail and keeps it in /doomscroll likes', { timeoutMs: 15000 }, async ($, on) => {
  fakeDaemon(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await eventually($, async () => (await ui.find({ type: 'Text', text: '@khaby.lame' })) !== undefined)

  await ui.press({ key: 'like' })
  expect(await ui.find({ type: 'Button', key: 'like', text: 'liked' })).toBeDefined()
  const { text } = await doomscroll($, 'likes')
  expect(text).toContain(ITEM.url)
  await ui.unmount()
})

test('/doomscroll add puts a creator in the feed', async ($, on) => {
  const daemon = fakeDaemon(on)
  await $.session.start(SESSION)
  await eventually($, () => daemon.ops.length > 0)

  const { text } = await doomscroll($, 'add @nasa @dog.lover')
  expect(text).toContain('@nasa, @dog.lover')
  expect(text).toContain('For You mix')
  expect(daemon.ops).toContain('creators')
})

test('the spinner counts the TikToks watched', { timeoutMs: 15000 }, async ($, on) => {
  const daemon = fakeDaemon(on)
  on('ui.render', { component: 'Spinner' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return Text({ children: e.props.message ?? e.props.word })
  })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await eventually($, () => daemon.ops.includes('play'))

  const ui = await $.ui.mount({
    plugin: 'doomscroll',
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
  })
  await eventually($, async () => (await ui.find({ type: 'Text', text: 'Sauteing · 3 TikToks deep' })) !== undefined)
  await ui.unmount()
})

test('without the keys the pane is just the video, the rail and one caption line', { timeoutMs: 15000 }, async ($, on) => {
  fakeDaemon(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false } })
  await eventually($, async () => (await ui.find({ type: 'Text', text: '@khaby.lame' })) !== undefined)
  expect(await ui.find({ type: 'Button', key: 'next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '❞ 4923' })).toBeDefined()
  await ui.unmount()
})

test('a headless run (claude -p) never starts the player or opens the pane', async ($, on) => {
  const daemon = fakeDaemon(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(TURN)
  expect(daemon.stats.spawns).toBe(0)
  expect(daemon.opened).toEqual([])
  expect(daemon.ops).toEqual([])
})

test('other surfaces get a note instead of a picture', async ($, on) => {
  fakeDaemon(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /plays in the terminal/ })).toBeDefined()
  await ui.unmount()
})
