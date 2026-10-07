
export interface FooterPopupSnapshot {
  navError: string | null
}

type Listener = (snapshot: FooterPopupSnapshot) => void

const listeners = new Set<Listener>()
let snapshot: FooterPopupSnapshot = { navError: null }

function emit(): void {
  for (const listener of [...listeners]) listener(snapshot)
}

export function getFooterPopupSnapshot(): FooterPopupSnapshot {
  return snapshot
}

export function subscribeFooterPopup(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setFooterNavError(message: string | null): void {
  if (snapshot.navError !== message) {
    snapshot = { ...snapshot, navError: message }
    emit()
  }
}
