import { spawnSync } from 'node:child_process'

const script = `import os,pty,subprocess,sys,time
m,s=pty.openpty()
p=subprocess.Popen(sys.argv[2:],stdin=s,stdout=s,stderr=s)
os.close(s)
out=b''
typed=False
while True:
 try:
  b=os.read(m,8192)
 except OSError: break
 if not b: break
 out+=b
 if not typed and out.endswith(b'> '):
  time.sleep(0.2)
  os.write(m,(sys.argv[1]+'\\n').encode())
  typed=True
sys.stdout.write(out.decode())
raise SystemExit(p.wait())
`

export function confirmInTerminal(request, argv, options) {
  if (request?.confirmation !== 'terminal') throw new Error(`Expected a terminal confirmation request, got ${JSON.stringify(request)}.`)
  const phrase = `confirm ${request.action} ${request.target} ${request.revision}`
  return spawnSync('python3', ['-c', script, phrase, ...argv], { timeout: 60_000, ...options, encoding: 'utf8' })
}
