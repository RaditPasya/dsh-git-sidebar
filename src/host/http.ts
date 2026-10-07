
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

export const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

export type JsonBodyOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'empty' | 'malformed' | 'too-large' }

/**
 * Reads a size-capped JSON body. The outcome distinguishes an empty body from
 * malformed JSON from an over-cap body so callers can answer 400 vs 413 instead
 * of collapsing every case into one opaque failure.
 */
export async function readJsonBody(
  req: IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<JsonBodyOutcome> {
  const maxBytes = opts.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      req.destroy()
      return { ok: false, reason: 'too-large' }
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return { ok: false, reason: 'empty' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}
