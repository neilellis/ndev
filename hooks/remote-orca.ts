import type { EngineInterface } from 'claude-code'

export function makeRun($: EngineInterface, timeoutMs: number) {
  return (argv: string[]) => $.process.run(argv, { timeoutMs })
}

export async function orca(run: ReturnType<typeof makeRun>, args: string[]) {
  const argv = ['orca', ...args, ...(args[0] === 'orchestration' ? ['--full'] : []), '--json']
  const { exitCode, stdout, stderr } = await run(argv)
  let receipt
  try { receipt = JSON.parse(stdout) } catch {}
  if (exitCode !== 0 || receipt?.ok !== true) {
    const error = receipt?.error
    const message = [error?.code, error?.message].filter(Boolean).join(': ') || stderr.trim() || stdout.trim() || 'missing JSON receipt'
    const next = Array.isArray(error?.data?.nextSteps) ? error.data.nextSteps.join(' ') : ''
    throw new Error(`orca ${args.slice(0, 2).join(' ')} exited ${exitCode}: ${message}${next ? '\nRepair: ' + next : ''}`)
  }
  return receipt.result
}
