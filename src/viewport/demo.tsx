/**
 * Standalone viewport test bench (dev only): http://localhost:5173/viewport-demo.html
 * Renders <Viewport> over a generated synthetic plate with local, in-memory state.
 */
/* @refresh reload */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import type { Annotation, AnnotationGroup, ID } from '../model/types'
import type { Tool, ViewportHandle, ViewState } from './api'
import { Viewport } from './Viewport'

type PlateStyle = 'light' | 'dark'

/** Draw a synthetic petri dish with colonies; returns an ImageBitmap (scratch canvas released). */
async function makePlate(width: number, height: number, style: PlateStyle, seed = 42): Promise<ImageBitmap> {
  let s = seed
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')!
  g.fillStyle = style === 'light' ? '#2a2c30' : '#0e0f11'
  g.fillRect(0, 0, width, height)
  const cx = width / 2
  const cy = height / 2
  const R = Math.min(width, height) * 0.46
  // rim
  g.beginPath()
  g.arc(cx, cy, R * 1.03, 0, Math.PI * 2)
  g.fillStyle = style === 'light' ? '#cfd3d6' : '#5a5f66'
  g.fill()
  // agar
  const agar = g.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.1, cx, cy, R)
  if (style === 'light') {
    agar.addColorStop(0, '#f1e3b8')
    agar.addColorStop(1, '#d9c48a')
  } else {
    agar.addColorStop(0, '#5a1414')
    agar.addColorStop(1, '#2a0606')
  }
  g.beginPath()
  g.arc(cx, cy, R, 0, Math.PI * 2)
  g.fillStyle = agar
  g.fill()
  // colonies
  const n = 600
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * R * 0.95
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    const r = 4 + rand() ** 2 * 28
    const col = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
    if (style === 'light') {
      col.addColorStop(0, '#fffdf5')
      col.addColorStop(0.7, '#efe6cf')
      col.addColorStop(1, 'rgba(190,170,120,0.9)')
    } else {
      col.addColorStop(0, '#f3f0e6')
      col.addColorStop(0.7, '#cfc6b2')
      col.addColorStop(1, 'rgba(120,90,80,0.9)')
    }
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fillStyle = col
    g.fill()
  }
  // glare
  g.beginPath()
  g.ellipse(cx - R * 0.45, cy - R * 0.5, R * 0.25, R * 0.06, -0.6, 0, Math.PI * 2)
  g.fillStyle = 'rgba(255,255,255,0.18)'
  g.fill()
  const bmp = await createImageBitmap(c)
  c.width = c.height = 0
  return bmp
}

let counter = 0
function makeAnnotation(x: number, y: number, groupId: ID): Annotation {
  const t = new Date().toISOString()
  return {
    id: `d${++counter}`,
    x,
    y,
    groupId,
    origin: 'manual',
    createdAt: t,
    updatedAt: t,
    reviewStatus: 'accepted',
    lastEditSource: 'manual',
    manuallyAdjusted: false,
  }
}

const initialGroups: AnnotationGroup[] = [
  { id: 'main', name: 'Main colonies', color: '#e5484d', render: 'dot', opacity: 0.9, size: 6, labels: false, labelSize: 12, hidden: false, locked: false },
  { id: 'small', name: 'Small colonies', color: '#3e63dd', render: 'circle', opacity: 1, size: 8, labels: true, labelSize: 12, hidden: false, locked: false },
  { id: 'review', name: 'To review', color: '#ffe14d', render: 'dot', opacity: 1, size: 5, labels: false, labelSize: 12, hidden: false, locked: false },
]

function Demo() {
  const [image, setImage] = createSignal<ImageBitmap | null>(null)
  const [size, setSize] = createSignal({ w: 6000, h: 4000 })
  const [plate, setPlate] = createSignal<PlateStyle>('light')
  const [annotations, setAnnotations] = createSignal<Annotation[]>([])
  const [groups, setGroups] = createSignal<AnnotationGroup[]>(initialGroups)
  const [activeId, setActiveId] = createSignal<ID | null>('main')
  const [tool, setTool] = createSignal<Tool>('add')
  const [touchAnnotates, setTouchAnnotates] = createSignal(false)
  const [view, setView] = createSignal<ViewState | null>(null)
  const [log, setLog] = createSignal<string[]>([])
  const [drawMs, setDrawMs] = createSignal('')
  const history: Annotation[][] = []
  let handle: ViewportHandle | undefined
  let host!: HTMLDivElement

  const say = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 8))
  const commit = (next: Annotation[]) => {
    history.push(annotations())
    setAnnotations(next)
  }
  const active = () => groups().find((g) => g.id === activeId())
  const patchActive = (p: Partial<AnnotationGroup>) =>
    setGroups((gs) => gs.map((g) => (g.id === activeId() ? { ...g, ...p } : g)))

  async function loadPlate() {
    const old = image()
    setImage(null)
    old?.close()
    const t0 = performance.now()
    const bmp = await makePlate(size().w, size().h, plate())
    say(`plate ${size().w}x${size().h} generated in ${(performance.now() - t0).toFixed(0)} ms`)
    setImage(bmp)
  }

  function generate(n: number) {
    const { w, h } = size()
    const ids = groups().map((g) => g.id)
    const extra = Array.from({ length: n }, (_, i) => makeAnnotation(Math.random() * w, Math.random() * h, ids[i % ids.length]))
    commit([...annotations(), ...extra])
    say(`generated ${n} markers`)
  }

  onMount(() => {
    void loadPlate()
    const timer = setInterval(() => {
      const root = host.querySelector<HTMLElement>('.cfu-viewport')
      if (root?.dataset.drawMs) setDrawMs(`${root.dataset.drawMs} ms / ${root.dataset.markersDrawn} markers`)
    }, 300)
    onCleanup(() => clearInterval(timer))
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'z') {
          const prev = history.pop()
          if (prev) setAnnotations(prev)
          e.preventDefault()
        }
        return
      }
      if (e.key === 'a') setTool('add')
      else if (e.key === 'e') setTool('erase')
      else if (e.key === 'h') setTool('pan')
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
    // Hook for automated checks.
    ;(window as unknown as Record<string, unknown>).__demo = {
      annotations,
      view,
      log,
      handle: () => handle,
      setTool,
      setActiveId,
      patchActive,
      generate,
      setTouchAnnotates,
    }
  })

  const counts = () => {
    const m = new Map<ID, number>()
    for (const a of annotations()) m.set(a.groupId, (m.get(a.groupId) ?? 0) + 1)
    return m
  }

  return (
    <div style={{ display: 'grid', 'grid-template-columns': 'minmax(220px, 260px) 1fr', height: '100%' }}>
      <aside style={{ padding: '12px', overflow: 'auto', 'border-right': '1px solid #dde0e4', display: 'grid', gap: '10px', 'align-content': 'start' }}>
        <strong>Viewport demo</strong>
        <fieldset>
          <legend>Tool (A / E / H)</legend>
          <For each={['add', 'erase', 'pan'] as Tool[]}>
            {(t) => (
              <label style={{ 'margin-right': '8px' }}>
                <input type="radio" name="tool" checked={tool() === t} onChange={() => setTool(t)} /> {t}
              </label>
            )}
          </For>
        </fieldset>
        <label>
          Active group{' '}
          <select value={activeId() ?? ''} onChange={(e) => setActiveId(e.currentTarget.value || null)}>
            <For each={groups()}>{(g) => <option value={g.id}>{g.name} ({counts().get(g.id) ?? 0})</option>}</For>
            <option value="">(none)</option>
          </select>
        </label>
        <Show when={active()}>
          {(g) => (
            <fieldset style={{ display: 'grid', gap: '4px' }}>
              <legend>Style: {g().name}</legend>
              <label><input type="checkbox" checked={g().hidden} onChange={(e) => patchActive({ hidden: e.currentTarget.checked })} /> hidden</label>
              <label><input type="checkbox" checked={g().locked} onChange={(e) => patchActive({ locked: e.currentTarget.checked })} /> locked</label>
              <label><input type="checkbox" checked={g().labels} onChange={(e) => patchActive({ labels: e.currentTarget.checked })} /> labels</label>
              <label>
                render{' '}
                <select value={g().render} onChange={(e) => patchActive({ render: e.currentTarget.value as 'dot' | 'circle' })}>
                  <option value="dot">dot</option>
                  <option value="circle">circle</option>
                </select>
              </label>
              <label>size {g().size}px <input type="range" min="2" max="24" value={g().size} onInput={(e) => patchActive({ size: +e.currentTarget.value })} /></label>
              <label>opacity {Math.round(g().opacity * 100)}% <input type="range" min="10" max="100" value={g().opacity * 100} onInput={(e) => patchActive({ opacity: +e.currentTarget.value / 100 })} /></label>
              <label>label size {g().labelSize}px <input type="range" min="8" max="32" value={g().labelSize} onInput={(e) => patchActive({ labelSize: +e.currentTarget.value })} /></label>
              <label>colour <input type="color" value={g().color} onInput={(e) => patchActive({ color: e.currentTarget.value })} /></label>
            </fieldset>
          )}
        </Show>
        <label><input type="checkbox" checked={touchAnnotates()} onChange={(e) => setTouchAnnotates(e.currentTarget.checked)} /> touch annotates</label>
        <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
          <button onClick={() => generate(5000)}>+5000 markers</button>
          <button onClick={() => commit([])}>Clear</button>
          <button onClick={() => { const p = history.pop(); if (p) setAnnotations(p) }}>Undo</button>
        </div>
        <fieldset style={{ display: 'grid', gap: '4px' }}>
          <legend>Plate</legend>
          <label>
            style{' '}
            <select value={plate()} onChange={(e) => { setPlate(e.currentTarget.value as PlateStyle); void loadPlate() }}>
              <option value="light">light agar</option>
              <option value="dark">dark (blood agar)</option>
            </select>
          </label>
          <label>
            size{' '}
            <select value={`${size().w}x${size().h}`} onChange={(e) => { const [w, h] = e.currentTarget.value.split('x').map(Number); setSize({ w, h }); void loadPlate() }}>
              <option value="1600x1200">1600x1200 (2 MP)</option>
              <option value="4000x3000">4000x3000 (12 MP)</option>
              <option value="6000x4000">6000x4000 (24 MP)</option>
            </select>
          </label>
        </fieldset>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => handle?.zoomOut()} aria-label="Zoom out">−</button>
          <button onClick={() => handle?.zoomIn()} aria-label="Zoom in">+</button>
          <button onClick={() => handle?.fit()}>Fit</button>
          <button onClick={() => handle?.setScale(1)}>1:1</button>
        </div>
        <div>
          Total: <b>{annotations().length}</b> · zoom {view() ? `${(view()!.scale * 100).toFixed(1)}%` : '–'}
          <br />
          Last annotation draw: {drawMs()}
        </div>
        <ol style={{ margin: 0, 'padding-left': '18px', color: '#555', 'font-size': '12px' }}>
          <For each={log()}>{(l) => <li>{l}</li>}</For>
        </ol>
      </aside>
      <div ref={host} style={{ position: 'relative', 'min-width': 0, 'min-height': 0 }}>
        <Viewport
          image={image()}
          imageWidth={size().w}
          imageHeight={size().h}
          annotations={annotations()}
          groups={groups()}
          activeGroupId={activeId()}
          tool={tool()}
          touchAnnotates={touchAnnotates()}
          onAdd={(x, y) => {
            commit([...annotations(), makeAnnotation(x, y, activeId()!)])
            say(`add (${x.toFixed(1)}, ${y.toFixed(1)})`)
          }}
          onErase={(id) => {
            commit(annotations().filter((a) => a.id !== id))
            say(`erase ${id}`)
          }}
          onBlocked={(r) => say(`blocked: ${r}`)}
          onViewChange={setView}
          ref={(h) => (handle = h)}
          label={`Synthetic plate, ${annotations().length} markers`}
        />
      </div>
    </div>
  )
}

render(() => <Demo />, document.getElementById('root')!)
