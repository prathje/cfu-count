/**
 * Procedurally drawn agar-plate photographs for the in-memory demo repository.
 * Only used while the real storage implementation is unavailable.
 */

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface SamplePlate {
  name: string
  blob: Blob
  width: number
  height: number
  /** Colony centres in image coordinates (used to seed demo annotations). */
  colonies: { x: number; y: number }[]
}

export async function drawSamplePlate(seed: number, name: string, colonyCount: number, tint: 'cream' | 'red' | 'amber'): Promise<SamplePlate> {
  const width = 1600
  const height = 1200
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const rand = rng(seed)

  // Bench background
  const bg = ctx.createLinearGradient(0, 0, width, height)
  bg.addColorStop(0, '#1d1f22')
  bg.addColorStop(1, '#2c2f33')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const cx = width / 2 + (rand() - 0.5) * 40
  const cy = height / 2 + (rand() - 0.5) * 30
  const r = 520

  // Dish rim + shadow
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 40
  ctx.beginPath()
  ctx.arc(cx, cy, r + 24, 0, Math.PI * 2)
  ctx.fillStyle = '#c9ccd0'
  ctx.fill()
  ctx.restore()

  const agarColors = {
    cream: ['#e9d9a6', '#d4bf80', '#b89f5c'],
    red: ['#b8423a', '#9b2f2a', '#6e1d1b'],
    amber: ['#d9a347', '#c08532', '#8f5d1d'],
  }[tint]
  const agar = ctx.createRadialGradient(cx - 120, cy - 140, 40, cx, cy, r)
  agar.addColorStop(0, agarColors[0])
  agar.addColorStop(0.7, agarColors[1])
  agar.addColorStop(1, agarColors[2])
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = agar
  ctx.fill()

  // Subtle agar texture
  for (let i = 0; i < 2500; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * r
    ctx.fillStyle = `rgba(255,255,255,${rand() * 0.04})`
    ctx.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2, 2)
  }

  const colonies: { x: number; y: number }[] = []
  const colonyTone = tint === 'red' ? ['#f4e9e0', '#e2cfc0'] : ['#fbf6e8', '#e6dcc0']
  for (let i = 0; i < colonyCount; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * (r - 40)
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    const size = 4 + rand() * rand() * 16
    const g = ctx.createRadialGradient(x - size * 0.3, y - size * 0.3, size * 0.1, x, y, size)
    g.addColorStop(0, colonyTone[0])
    g.addColorStop(0.8, colonyTone[1])
    g.addColorStop(1, 'rgba(0,0,0,0.15)')
    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fillStyle = g
    ctx.fill()
    colonies.push({ x, y })
  }

  // Glare
  const glare = ctx.createRadialGradient(cx - r * 0.45, cy - r * 0.5, 10, cx - r * 0.45, cy - r * 0.5, r * 0.5)
  glare.addColorStop(0, 'rgba(255,255,255,0.18)')
  glare.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glare
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), 'image/jpeg', 0.88),
  )
  return { name, blob, width, height, colonies }
}
