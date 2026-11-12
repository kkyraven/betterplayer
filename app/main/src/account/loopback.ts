import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Redirect = { code: string } | { error: string }

export interface Loopback {
  redirectUri: string
  state: string
  codeVerifier: string
  codeChallenge: string
  close(): void
}

export async function openLoopback(onRedirect: (redirect: Redirect) => Promise<string>): Promise<Loopback> {
  const state = randomBytes(16).toString('base64url')
  const codeVerifier = randomBytes(32).toString('base64url')
  let answered = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (req.method !== 'GET' || url.pathname !== '/cb' || url.searchParams.get('state') !== state || answered || !(code || error)) {
      res.writeHead(400, { Connection: 'close' }).end()
      return
    }
    answered = true
    void onRedirect(code ? { code } : { error: error ?? '' }).then(
      (location) => res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', Connection: 'close' }).end(),
      () => res.writeHead(500, { Connection: 'close' }).end(),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cb`,
    state,
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
    close() {
      server.close()
      server.closeAllConnections()
    },
  }
}
