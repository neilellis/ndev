import { createServer } from 'node:http'

const port = Number(process.env.FIXTURE_PORT)
const routes = (process.env.FIXTURE_ROUTES ?? '/').split(',')
createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname
  const known = routes.includes(path)
  console.log(`GET ${path} ${known ? 200 : 404}`)
  response.statusCode = known ? 200 : 404
  response.end(known ? `page ${path}` : 'not found')
}).listen(port, '127.0.0.1')
