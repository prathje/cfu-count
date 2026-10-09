/** Minimal `--key value` / `--flag` argument parser for the eval scripts. */
export interface Args {
  _: string[]
  [key: string]: string | boolean | string[] | undefined
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i]
      else out[a.slice(2)] = true
    } else out._.push(a)
  }
  return out
}
