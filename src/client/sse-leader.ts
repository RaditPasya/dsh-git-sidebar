
export interface SseRelaySeams {
  eventSource?: typeof EventSource
  broadcastChannel?: typeof BroadcastChannel
  locks?: LockManager
}

interface Relay {
  listeners: Set<(data: string) => void>
  destroy(): void
}

const relays = new Map<string, Relay>()

export function subscribeSharedEvents(
  url: string,
  eventName: string,
  onEvent: (data: string) => void,
  seams: SseRelaySeams = {},
): () => void {
  const key = eventName + ' ' + url
  let relay = relays.get(key)
  if (relay === undefined) {
    relay = createRelay(key, url, eventName, seams)
    relays.set(key, relay)
  }
  relay.listeners.add(onEvent)
  return () => {
    const current = relays.get(key)
    if (current === undefined) return
    current.listeners.delete(onEvent)
    if (current.listeners.size === 0) {
      current.destroy()
      relays.delete(key)
    }
  }
}

function createRelay(key: string, url: string, eventName: string, seams: SseRelaySeams): Relay {
  const listeners = new Set<(data: string) => void>()
  const dispatch = (data: string): void => {
    for (const listener of [...listeners]) listener(data)
  }

  const EventSourceImpl = seams.eventSource ?? EventSource
  const ChannelImpl = seams.broadcastChannel
    ?? (typeof BroadcastChannel === 'undefined' ? undefined : BroadcastChannel)
  const locks = seams.locks
    ?? (typeof navigator === 'undefined' || navigator.locks === undefined ? undefined : navigator.locks)

  if (ChannelImpl === undefined || locks === undefined) {
    const source = new EventSourceImpl(url)
    source.addEventListener(eventName, (raw) => { dispatch((raw as MessageEvent).data as string) })
    return { listeners, destroy: () => { source.close() } }
  }

  const channel = new ChannelImpl('dsh-sse:' + key)
  channel.addEventListener('message', (raw) => { dispatch((raw as MessageEvent).data as string) })

  const abort = new AbortController()
  let release: (() => void) | undefined
  let source: EventSource | undefined
  void locks.request('dsh-sse:' + key, { signal: abort.signal }, () => {
    source = new EventSourceImpl(url)
    source.addEventListener(eventName, (raw) => {
      const data = (raw as MessageEvent).data as string
      channel.postMessage(data)
      dispatch(data)
    })
    return new Promise<void>(resolve => { release = resolve })
  }).catch(() => {
  })

  return {
    listeners,
    destroy() {
      channel.close()
      abort.abort()
      release?.()
      source?.close()
    },
  }
}
