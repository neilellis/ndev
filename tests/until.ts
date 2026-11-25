declare function setTimeout(fn: () => void, ms: number): unknown
declare function clearTimeout(timer: unknown): void

export async function until(description: string, ready: () => boolean | Promise<boolean>, state: () => unknown, timeoutMs = 30_000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError(`Readiness timeoutMs must be finite and non-negative: ${timeoutMs}`)
  let stopped = false
  let timer: unknown
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = true
      let detail: string | undefined
      try {
        detail = JSON.stringify(state())
      } catch (error) {
        detail = `state could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
      reject(new Error(`Timed out waiting for ${description}: ${detail}`))
    }, timeoutMs)
  })
  const check = async () => {
    while (!stopped) {
      if (await ready()) return
      if (!stopped) await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    await Promise.race([check(), expired])
  } finally {
    stopped = true
    clearTimeout(timer)
  }
}
