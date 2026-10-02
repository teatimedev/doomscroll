import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, Register } from 'claude-code'

import type { DoomscrollItem, DoomscrollView } from '../types'

// Doomscroll: a TikTok-style "For You" pane that plays while Claude works.
//
// bin/doomscrolld.py does the heavy lifting (feed, downloads, ffmpeg): it writes
// each decoded frame to shared memory and prints its name, and this module
// blits that name into a keyed Image, so no pixel crosses `$`. Commands go
// back to it over HTTP on a Unix socket.

const PANE = 'doomscroll'
const TITLE = 'For You'
const BELOW = 3 // progress bar, caption line, controls line
const RAIL = 8 // "♥ 292K" and its kin, tight to the video's right edge
const GAP = 1
const BLACK_BG = '#000000' // until the daemon says what the terminal's background is
const FG = '#f1f1f2'
const DIM = '#8a8b91'
const FALLBACK_CELL = { cw: 8, ch: 17 }
const ACCENT = '#fe2c55'

const EMPTY: DoomscrollView = {
  status: 'starting',
  index: -1,
  total: 0,
  item: null,
  muted: false,
  watched: 0,
  message: null,
  poster: null,
  ahead: 0,
  cell: null,
  term: null,
}

const view = atom({ plugin: 'doomscroll', key: 'view' } as const, EMPTY)
const isWorking = atom({ plugin: 'doomscroll', key: 'isWorking' } as const, false)
const isSnoozed = atom({ plugin: 'doomscroll', key: 'isSnoozed' } as const, false)
const isHeld = atom({ plugin: 'doomscroll', key: 'isHeld' } as const, false)
const isUserPaused = atom({ plugin: 'doomscroll', key: 'isUserPaused' } as const, false)
const isDone = atom({ plugin: 'doomscroll', key: 'isDone' } as const, false) // a turn ended since the last swipe
const liked = atom({ plugin: 'doomscroll', key: 'liked' } as const, [])

type Frame = { source: ImageSource; pos: number; dur: number }

// The daemon's socket and the frame pump: module state, rebuilt on a reload
// along with the daemon itself.
let sock: string | null = null
// Set when the terminal draws the Image's alt instead of pixels: no decoding.
let isBlind = false
// Set when playback paused because the pane went out of view (a dialog over
// it, another tab): the pane's next draw resumes it.
let isHiddenPause = false
// Only an interactive terminal session runs the player: never a `claude -p`
// run, a scheduled task or the desktop app, which would play sound to nobody.
let isActive = false
let frame: Frame | null = null
let isBlitting = false
let framesSinceBar = 0
let deniedFrames = 0
let mounted = { cols: 0, rows: 0 } // the Image's size, as the pane last drew it
// The Image and the bar are keyed by their size: the engine keeps an image's
// placement grid (c, r) from its first draw under a key, so a resize under the
// same key draws the picture at the old size inside the new box.
let videoKey = 'video'
let background = BLACK_BG
let barKey = 'bar'
let sized = { cols: 0, rows: 0 } // the size the daemon decodes at
let lastTickAt = 0
let lastSwipeAt = 0

// ------------------------------------------------------------------ helpers

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? BASE64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? BASE64.charAt(n & 63) : '='
  }
  return out
}

/** One pixel of the background colour: what the Image shows before any frame. */
function blank(background: string): ImageSource {
  const n = Number.parseInt(background.slice(1), 16) || 0
  return { rgba: toBase64(new Uint8Array([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255])), width: 1, height: 1 }
}

/** The progress bar as Raster cells: played `━` white, the rest a dim `─`. */
function barCells(columns: number, fraction: number, background: string): string {
  const bg = Number.parseInt(background.slice(1), 16) || 0
  const words = new Uint32Array(columns * 3)
  const filled = Math.round(columns * Math.min(1, Math.max(0, fraction)))
  for (let i = 0; i < columns; i++) {
    words[i * 3] = i < filled ? 0x2501 : 0x2500
    words[i * 3 + 1] = i < filled ? 0xf1f1f2 : 0x3c3c40
    words[i * 3 + 2] = bg
  }
  return toBase64(new Uint8Array(words.buffer))
}

function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  // Short enough for the rail: 4923, 19.7K, 292K, 1.2M
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e5) return `${Math.round(n / 1e3)}K`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function feedLine(yours: readonly string[], isMix: boolean): string {
  const list = yours.length > 0 ? yours.map(h => `@${h}`).join(', ') : 'none yet'
  return `Your creators: ${list}${isMix ? ', plus the For You mix (about 70 creators: comedy, memes, slop, animals, sports and more).' : '. The For You mix is off.'}`
}

function handles(words: readonly string[]): string[] {
  return words.map(w => w.trim().replace(/^@/, '').toLowerCase()).filter(w => /^[a-z0-9._]{2,24}$/.test(w))
}

/**
 * The video box in cells (9:16 at the terminal's real cell shape), the rail
 * beside it, and a left spacer as wide as the rail when there is room for
 * one, so the video itself sits in the middle of the pane.
 */
function layout(bodyCols: number, bodyRows: number, cell: DoomscrollView['cell']) {
  const { cw, ch } = cell ?? FALLBACK_CELL
  const aspect = (9 / 16) * (ch / cw) // columns per row of a 9:16 picture
  const side = RAIL + GAP
  let rows = Math.max(4, bodyRows - BELOW)
  let cols = Math.round(rows * aspect)
  let rail = side
  if (cols + side + 2 > bodyCols) {
    cols = bodyCols - side - 2
    if (cols < 16) {
      rail = 0
      cols = bodyCols - 2
    }
    rows = Math.max(4, Math.min(bodyRows - BELOW, Math.round(cols / aspect)))
  }
  cols = Math.max(1, Math.min(255, cols))
  rows = Math.max(1, Math.min(255, rows))
  const spacer = rail > 0 && cols + 2 * side + 2 <= bodyCols ? side : 0
  return { cols, rows, rail, spacer }
}

/** The dock width that seats the video centered with the rail beside it. */
function wantedColumns(v: DoomscrollView): number {
  const rows = v.term ? v.term.rows - 7 : 36
  const box = layout(999, rows, v.cell)
  return box.cols + 2 * (RAIL + GAP) + 4
}

// ------------------------------------------------------------------- daemon

/** A command whose answer matters (doctor): the daemon's JSON reply, or null. */
async function ask($: EngineInterface, body: Record<string, unknown>): Promise<unknown> {
  if (sock === null) return null
  try {
    const res = await $.http.fetch('http://doomscrolld/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: sock,
    })
    return res.ok ? JSON.parse(res.text) : null
  } catch {
    return null
  }
}

async function send($: EngineInterface, body: Record<string, unknown>): Promise<void> {
  if (sock === null) return
  try {
    await $.http.fetch('http://doomscrolld/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: sock,
    })
  } catch (error) {
    $.ui.log(`doomscroll: ${String(error)}`, { to: 'debug' })
  }
}

/** Tells the daemon the box the pane drew, so frames come at its shape. */
async function syncSize($: EngineInterface): Promise<void> {
  if (mounted.cols === 0 || (mounted.cols === sized.cols && mounted.rows === sized.rows)) return
  sized = mounted
  await send($, { op: 'size', cols: mounted.cols, rows: mounted.rows })
}

/** Play only while the pane is on screen and Claude is busy (or they asked). */
async function syncPlayback($: EngineInterface): Promise<void> {
  if (sock === null) return
  await syncSize($)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  const isShown = pane !== undefined && pane.isShown && pane.isPlaced
  const [working, snoozed, held, paused] = await Promise.all([
    read($, isWorking),
    read($, isSnoozed),
    read($, isHeld),
    read($, isUserPaused),
  ])
  const shouldPlay = isShown && !isBlind && !snoozed && !paused && (working || held)
  await send($, { op: shouldPlay ? 'play' : 'pause' })
}

function onFrame($: EngineInterface, line: string): void {
  const [, kind, name = '', gen, w, h, pos, dur] = line.split(' ')
  const width = Number(w)
  const height = Number(h)
  frame = {
    source:
      kind === 'shm'
        ? { shm: name, format: 'rgb', width, height }
        : { file: name, format: 'rgb', width, height, generation: Number(gen) },
    pos: Number(pos),
    dur: Number(dur),
  }
  if (!isBlitting) void pump($)
  if (mounted.cols !== sized.cols || mounted.rows !== sized.rows) void syncSize($)
}

/** Blits the newest frame; frames that land mid-blit fold into the next one. */
async function pump($: EngineInterface): Promise<void> {
  isBlitting = true
  try {
    let sent: Frame | null = null
    while (frame !== null && frame !== sent) {
      sent = frame
      const shown = await $.ui.blit({ requestId: PANE, key: videoKey, source: sent.source })
      if (shown.deny !== undefined) {
        // Not on screen (closed, another tab), or a terminal without kitty
        // graphics drawing the alt: pause rather than decode for nobody.
        deniedFrames += 1
        if (deniedFrames === 15) void onBlocked($, shown.deny)
        break
      }
      deniedFrames = 0
      framesSinceBar += 1
      if (framesSinceBar >= 6 && mounted.cols > 0 && sent.dur > 0) {
        framesSinceBar = 0
        await $.ui.blit({
          requestId: PANE,
          key: barKey,
          cells: barCells(mounted.cols, sent.pos / sent.dur, background),
        })
      }
    }
  } finally {
    isBlitting = false
  }
}

async function onBlocked($: EngineInterface, reason: string): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane !== undefined && pane.isShown && pane.isPlaced) {
    isBlind = true
    $.ui.log(`doomscroll: frames refused while the pane is up (${reason}); stopping playback`, { to: 'debug' })
    await update($, view, (v): DoomscrollView => ({
      ...v,
      status: 'empty',
      message: "This terminal can't draw video. Doomscroll needs Ghostty or kitty.",
    }))
  } else {
    isHiddenPause = true
  }
  await syncPlayback($)
}

async function onLine($: EngineInterface, line: string): Promise<void> {
  if (line.startsWith('R ')) {
    sock = line.slice(2).trim()
    sized = { cols: 0, rows: 0 }
    await syncPlayback($)
  } else if (line.startsWith('S ')) {
    if (isBlind) return
    const next = JSON.parse(line.slice(2)) as DoomscrollView
    await update($, view, () => next)
  } else if (line.startsWith('E ')) {
    $.ui.log(`doomscroll: ${line.slice(2)}`, { to: 'debug' })
  }
}

async function runDaemon($: EngineInterface, creatorsOption: string, isMix: boolean, soundDefault: boolean) {
  const stored = await $.store.get('creators')
  const creators = Array.isArray(stored) ? handles(stored.map(String)) : handles(creatorsOption.split(','))
  const storedMute = await $.store.get('muted')
  const isMuted = typeof storedMute === 'boolean' ? storedMute : !soundDefault

  for (let attempt = 0; attempt < 3; attempt++) {
    const socketPath = `/tmp/doomscroll-${Math.random().toString(36).slice(2, 10)}.sock`
    const argv = ['python3', `${$.plugin.root}/bin/doomscrolld.py`, '--sock', socketPath, '--creators', creators.join(',')]
    if (!isMix) argv.push('--no-mix')
    if (isMuted) argv.push('--muted')
    let buffer = ''
    try {
      for await (const chunk of $.process.spawn({ argv })) {
        if (chunk.stream === 'stderr') {
          $.ui.log(`doomscrolld: ${chunk.text.trim()}`, { to: 'debug' })
          continue
        }
        buffer += chunk.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        let latest: string | null = null
        for (const line of lines) {
          if (line.startsWith('F ')) latest = line
          else await onLine($, line)
        }
        if (latest !== null) onFrame($, latest)
      }
    } catch (error) {
      $.ui.log(`doomscroll: the player stopped: ${String(error)}`, { to: 'debug' })
    }
    sock = null
    await $.clock.sleep(2000)
  }
  await update($, view, (v): DoomscrollView => ({
    ...v,
    status: 'empty',
    message: 'The Doomscroll player keeps stopping. It needs python3 (3.8+); /doomscroll doctor says more.',
  }))
}

// -------------------------------------------------------------------- actions

async function openPane($: EngineInterface, isAsked: boolean) {
  const v = await read($, view)
  const rows = v.term ? Math.max(12, v.term.rows - 10) : 30
  return $.ui.open({
    id: PANE,
    title: TITLE,
    columns: wantedColumns(v),
    rows,
    ...(isAsked ? { focus: true as const } : {}),
  })
}

async function swipe($: EngineInterface, op: 'next' | 'prev') {
  await update($, isDone, () => false)
  await update($, isUserPaused, () => false)
  if (!(await read($, isWorking))) await update($, isHeld, () => true)
  await send($, { op })
}

async function togglePause($: EngineInterface) {
  const v = await read($, view)
  if (v.status === 'playing' || v.status === 'loading') {
    await update($, isUserPaused, () => true)
  } else {
    await update($, isDone, () => false)
    await update($, isUserPaused, () => false)
    if (!(await read($, isWorking))) await update($, isHeld, () => true)
  }
  await syncPlayback($)
}

async function toggleMute($: EngineInterface, muted?: boolean) {
  const next = muted ?? !(await read($, view)).muted
  await $.store.set('muted', next)
  await send($, { op: 'mute', muted: next })
  return next
}

async function toggleLike($: EngineInterface, item: DoomscrollItem) {
  const ids = await read($, liked)
  const isLiked = ids.includes(item.id)
  await update($, liked, list => (isLiked ? list.filter(id => id !== item.id) : [...list, item.id]))
  const saved = await $.store.get('likes')
  const list = Array.isArray(saved) ? (saved as { id: string }[]) : []
  await $.store.set(
    'likes',
    isLiked
      ? list.filter(one => one.id !== item.id)
      : [...list, { id: item.id, url: item.url, author: item.author, desc: clip(item.desc, 80) }].slice(-200),
  )
}

// ------------------------------------------------------------------- register

export const register: Register = (on, options) => {
  const creatorsOption = typeof options.creators === 'string' ? options.creators : ''
  const isMix = options.mix !== false
  const soundDefault = options.sound !== false
  const autoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isActive = e.isInteractive && e.surface === 'terminal'
    if (!isActive) return started
    await $.command.register({
      name: 'doomscroll',
      description: 'Scroll TikToks in a side pane while Claude works',
      argumentHint: '[off | mute | unmute | add @user | remove @user | creators | likes | doctor]',
      immediate: true,
    })
    const saved = await $.store.get('likes')
    if (Array.isArray(saved)) {
      const ids = (saved as { id: string }[]).map(one => one.id)
      await update($, liked, () => ids)
    }
    void runDaemon($, creatorsOption, isMix, soundDefault)
    return started
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (!isActive) return started
    isBlind = false // the terminal gets another chance each turn
    deniedFrames = 0
    await update($, isWorking, () => true)
    await update($, isDone, () => false)
    await update($, isUserPaused, () => false)
    if (autoOpen && !(await read($, isSnoozed))) await openPane($, false)
    await syncPlayback($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!isActive || e.agentId !== undefined) return done // a subagent's turn; the main one runs on
    const { status } = await read($, view)
    const wasPlaying = status === 'playing' || status === 'loading'
    await update($, isDone, () => wasPlaying)
    await update($, isWorking, () => false)
    await update($, isHeld, () => false)
    await syncPlayback($)
    if (wasPlaying && !(await read($, isSnoozed))) $.ui.toast("Claude's done. Back to work.")
    return done
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') {
      await update($, isSnoozed, () => true)
      $.ui.toast('Doomscroll snoozed. /doomscroll brings it back.')
    }
    await send($, { op: 'pause' })
    return closed
  })

  // The wheel over the pane is the swipe: one per gesture, however many ticks.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    if (e.by === 0) return {}
    const now = await $.clock.now()
    const gap = now - lastTickAt
    lastTickAt = now
    if (gap < 220 && now - lastSwipeAt < 1100) return {}
    lastSwipeAt = now
    await swipe($, e.by > 0 ? 'next' : 'prev')
    return {}
  })

  on('command.run', { command: 'doomscroll' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (verb.toLowerCase()) {
      case '':
      case 'on': {
        isBlind = false
        deniedFrames = 0
        await send($, { op: 'recheck' }) // picks up ffmpeg / yt-dlp installed since the session began
        await update($, isSnoozed, () => false)
        await update($, isUserPaused, () => false)
        await update($, isHeld, () => true)
        const opened = await openPane($, true)
        await syncPlayback($)
        return {
          text: opened.isPlaced
            ? 'Doomscroll is open. Scroll over it for the next video.'
            : `Doomscroll is waiting for room: ${opened.reason}`,
        }
      }
      case 'off': {
        await update($, isSnoozed, () => true)
        await $.ui.close({ id: PANE })
        await send($, { op: 'pause' })
        return { text: 'Doomscroll is off for this session. /doomscroll brings it back.' }
      }
      case 'mute':
      case 'unmute': {
        const muted = await toggleMute($, verb.toLowerCase() === 'mute')
        return { text: muted ? 'Doomscroll muted.' : 'Doomscroll sound on.' }
      }
      case 'add':
      case 'remove': {
        const stored = await $.store.get('creators')
        const current = Array.isArray(stored) ? handles(stored.map(String)) : handles(creatorsOption.split(','))
        const named = handles(rest)
        if (named.length === 0) return { text: `Usage: /doomscroll ${verb} @handle` }
        const next =
          verb.toLowerCase() === 'add'
            ? [...current, ...named.filter(h => !current.includes(h))]
            : current.filter(h => !named.includes(h))
        await $.store.set('creators', next)
        await send($, { op: 'creators', creators: next })
        return { text: feedLine(next, isMix) }
      }
      case 'creators':
      case 'list': {
        const stored = await $.store.get('creators')
        const current = Array.isArray(stored) ? handles(stored.map(String)) : handles(creatorsOption.split(','))
        return { text: feedLine(current, isMix) }
      }
      case 'likes': {
        const saved = await $.store.get('likes')
        const list = Array.isArray(saved) ? (saved as { url: string; author: string; desc: string }[]) : []
        if (list.length === 0) return { text: 'No likes yet. Press l on a video you like.' }
        return { text: list.map(one => `@${one.author}: ${one.desc}\n  ${one.url}`).join('\n') }
      }
      case 'doctor': {
        const reply = (await ask($, { op: 'doctor' })) as { doctor?: unknown } | null
        if (reply === null || reply.doctor === undefined) {
          return { text: 'The Doomscroll player is not running. It needs python3 (3.8+) on PATH; see the README.' }
        }
        return { text: `Doomscroll doctor:\n${JSON.stringify(reply.doctor, null, 2)}` }
      }
      default:
        return { text: 'Usage: /doomscroll [off | mute | unmute | add @user | remove @user | creators | likes | doctor]' }
    }
  })

  // "Sautéing… · 4 TikToks deep"
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const v = await read($, view)
    if (v.watched === 0 || v.status !== 'playing') return next(e)
    const base = e.props.message ?? e.props.word
    const deep = `${v.watched} TikTok${v.watched === 1 ? '' : 's'} deep`
    return next({ ...e, props: { ...e.props, message: `${base} · ${deep}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, view)
    const [held, done, likedIds] = await Promise.all([read($, isHeld), read($, isDone), read($, liked)])

    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>For You</Text>
          <Text dimColor>The video plays in the terminal (Ghostty or kitty).</Text>
        </Box>
      )
    }

    const { Box, Text, Button, Image, Raster } = $.ui.resolve(e)
    const bodyCols = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows
    const box = layout(bodyCols, bodyRows, v.cell)
    // Recorded only: the daemon's loop sends it (a send from here dies with
    // this render when a newer one supersedes it).
    if (box.cols !== mounted.cols || box.rows !== mounted.rows) mounted = { cols: box.cols, rows: box.rows }
    if (isHiddenPause) {
      // Drawn again after being out of view: play on if Claude still works.
      isHiddenPause = false
      deniedFrames = 0
      void syncPlayback($)
    }
    videoKey = `video-${box.cols}x${box.rows}`
    barKey = `bar-${box.cols}`

    const item = v.item
    const isPlaying = v.status === 'playing'
    const BG = v.bg ?? BLACK_BG
    background = BG
    const source: ImageSource =
      isPlaying && frame !== null
        ? frame.source
        : v.poster !== null
          ? { file: v.poster.file, format: 'rgb', width: v.poster.width, height: v.poster.height, generation: v.poster.generation }
          : blank(BG)
    const fraction = frame !== null && frame.dur > 0 ? frame.pos / frame.dur : 0
    const isLiked = item !== null && likedIds.includes(item.id)
    const isBackToWork = done && !held && v.status === 'paused'
    const under = box.cols + box.rail // the caption runs under the video and the rail

    // One line under the video: the post, or what is going on instead.
    const caption = (() => {
      if (v.status === 'starting' || v.status === 'warming')
        return <Text color={DIM} wrap="truncate">Loading your For You page…</Text>
      if (v.status === 'empty')
        return <Text color={DIM} wrap="truncate">{v.message ?? 'Nothing to watch. /doomscroll add @someone'}</Text>
      if (isBackToWork)
        return <Text color={ACCENT} bold wrap="truncate">Claude's done. Back to work.</Text>
      if (item === null) return <Text color={DIM}> </Text>
      return (
        <Text color={DIM} wrap="truncate">
          {v.status === 'paused' ? <Text color={FG}>❚❚ </Text> : null}
          {v.status === 'loading' ? <Text color={FG}>… </Text> : null}
          <Text color={FG} bold>{`@${item.author}`}</Text>
          {` ${item.desc}`}
        </Text>
      )
    })()

    const rail = box.rail > 0 && (
      <Box flexDirection="column" width={RAIL} marginLeft={GAP} alignItems="flex-start">
        {item !== null && (
          <Text>
            <Text color={BG} backgroundColor={FG} bold>{` ${item.author.slice(0, 1).toUpperCase()} `}</Text>
            <Text color={ACCENT} bold>+</Text>
          </Text>
        )}
        <Text color={FG}> </Text>
        <Text color={isLiked ? ACCENT : FG}>
          {'♥ '}
          <Text color={FG}>{count(item === null ? null : (item.likes ?? 0) + (isLiked ? 1 : 0))}</Text>
        </Text>
        <Text color={FG}>{`❞ ${count(item?.comments)}`}</Text>
        <Text color={FG}>{`⚑ ${count(item?.saves)}`}</Text>
        <Text color={FG}>{`➦ ${count(item?.shares)}`}</Text>
        {v.muted && <Text color={DIM}>♪ off</Text>}
      </Box>
    )

    // Controls only while the pane holds the keys (a click, ctrl+x tab): the
    // hotkeys need their Buttons drawn. Otherwise a hint for the first few.
    const controls = e.props.isFocused ? (
      <Box flexDirection="row" columnGap={2}>
        <Button key="next" plain hotkey="j" label="↓" onPress={() => swipe($, 'next')} />
        <Button key="prev" plain hotkey="k" label="↑" onPress={() => swipe($, 'prev')} />
        <Button key="pause" plain hotkey="p" label={isPlaying ? '❚❚' : '▶'} onPress={() => togglePause($)} />
        <Button key="mute" plain hotkey="m" label={v.muted ? '♪ on' : '♪ off'} onPress={() => toggleMute($)} />
        {item !== null && <Button key="like" plain hotkey="l" label={isLiked ? '♥ liked' : '♥'} onPress={() => toggleLike($, item)} />}
        {item !== null && <Button key="open" plain hotkey="o" label="↗" onPress={() => send($, { op: 'open' })} />}
      </Box>
    ) : (
      <Text color={DIM} wrap="truncate">{v.watched <= 2 && isPlaying ? 'scroll for the next one · click for keys' : ' '}</Text>
    )

    return (
      <Box flexDirection="column" width={bodyCols} height={bodyRows} backgroundColor={BG} alignItems="center" justifyContent="center">
        <Box flexDirection="row" alignItems="flex-end">
          {box.spacer > 0 && <Box width={box.spacer} />}
          <Image key={videoKey} source={source} columns={box.cols} rows={box.rows} alt="Doomscroll needs Ghostty or kitty" />
          {rail}
        </Box>
        <Box flexDirection="row">
          {box.spacer > 0 && <Box width={box.spacer} />}
          <Box flexDirection="column" width={under}>
            <Raster key={barKey} columns={box.cols} rows={1} cells={barCells(box.cols, fraction, BG)} />
            {caption}
            {controls}
          </Box>
        </Box>
      </Box>
    )
  })
}
