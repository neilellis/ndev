import { createServer } from 'node:http'

const port = Number(process.env.FIXTURE_PORT)
createServer((request, response) => response.end('fixture ready')).listen(port, '127.0.0.1')
