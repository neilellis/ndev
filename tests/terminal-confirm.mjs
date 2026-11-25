import { spawnSync } from 'node:child_process'

const script = `import os,pty,subprocess,sys
m,s=pty.openpty()
os.write(m,(sys.argv[1]+'\\n').encode())
p=subprocess.Popen(sys.argv[2:],stdin=s,stdout=s,stderr=s)
os.close(s)
out=b''
while True:
 try:
  b=os.read(m,8192)
 except OSError: break
 if not b: break
 out+=b
sys.stdout.write(out.decode())
raise SystemExit(p.wait())
`

export function confirmInTerminal(request, argv, options) {
  if (request?.confirmation !== 'terminal') throw new Error(`Expected a terminal confirmation request, got ${JSON.stringify(request)}.`)
  const phrase = `confirm ${request.action} ${request.target} ${request.revision}`
  return spawnSync('python3', ['-c', script, phrase, ...argv], { ...options, encoding: 'utf8' })
}
