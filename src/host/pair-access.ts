import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest } from './loopback.ts'

interface PairingAccess {
  isPairedDevice(request: IncomingMessage): boolean
}

interface LookupCtx {
  get?(name: string, strict?: boolean): unknown
  remoteWebUiPairing?: PairingAccess
}

export function isPairedOrLoopbackAllowed(ctx: LookupCtx, request: IncomingMessage): boolean {
  if (isLoopbackRequest(request)) return true
  const fromGet = typeof ctx.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined
  const pairing = (isPairingAccess(fromGet) ? fromGet : ctx.remoteWebUiPairing)
  return pairing?.isPairedDevice(request) === true
}

function isPairingAccess(value: unknown): value is PairingAccess {
  return value !== undefined
    && value !== null
    && typeof (value as PairingAccess).isPairedDevice === 'function'
}
