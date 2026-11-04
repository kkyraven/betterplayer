import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { blankHeaders, portalHeaders, readPortalAsk, type PortalStills } from '../library/portals'
import { ToolMissingError } from '../library/tools'

export async function servePortal(library: { portals: Pick<PortalStills, 'still'> }, req: IncomingMessage, res: ServerResponse, id: string | undefined): Promise<number> {
  const end = (status: number, headers: Record<string, string> = {}, body?: Buffer) => {
    res.writeHead(status, status === 204 ? headers : { ...headers, 'Content-Length': String(body?.length ?? 0) })
    res.end(req.method === 'HEAD' ? undefined : body)
    return status
  }
  const ask = readPortalAsk(id, new URL(req.url ?? '/', 'http://library').searchParams)
  if (!ask) return end(404)
  try {
    const still = await library.portals.still(ask.id, ask.width, ask.ms)
    if (!still) return end(404)
    if ('blank' in still) return end(204, blankHeaders())
    return end(200, { 'Content-Type': still.type, ...portalHeaders(still.info) }, await readFile(still.file))
  } catch (e) {
    return end(e instanceof ToolMissingError ? 503 : 404)
  }
}
