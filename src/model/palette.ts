/**
 * Default annotation-group palette: the Okabe–Ito colour-blind-safe set,
 * ordered so the first few groups are maximally distinct from each other and
 * from typical agar/plate backgrounds. Names are used for accessible labels so
 * colour is never the only identifier.
 */
export interface PaletteColor {
  name: string
  value: string
}

export const GROUP_PALETTE: readonly PaletteColor[] = [
  { name: 'Vermilion', value: '#d55e00' },
  { name: 'Sky blue', value: '#56b4e9' },
  { name: 'Bluish green', value: '#009e73' },
  { name: 'Yellow', value: '#f0e442' },
  { name: 'Blue', value: '#0072b2' },
  { name: 'Orange', value: '#e69f00' },
  { name: 'Reddish purple', value: '#cc79a7' },
  { name: 'Black', value: '#000000' },
]

export function colorName(hex: string): string {
  const match = GROUP_PALETTE.find((c) => c.value.toLowerCase() === hex.toLowerCase())
  return match ? match.name : `Custom ${hex.toLowerCase()}`
}

/** First palette colour not used by an existing group (cycles when all are taken). */
export function nextGroupColor(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  const free = GROUP_PALETTE.find((c) => !taken.has(c.value))
  return (free ?? GROUP_PALETTE[used.length % GROUP_PALETTE.length]).value
}
