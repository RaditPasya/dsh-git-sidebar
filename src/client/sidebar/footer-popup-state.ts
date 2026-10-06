
export interface FooterPopupSnapshot {
  open: boolean
  navError: string | null
}

type Listener = (snapshot: FooterPopupSnapshot) => void

const listeners = new Set<Listener>()
let snapshot: FooterPopupSnapshot = { open: false, navError: null }

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

export function openFooterPopup(): void {
  if (!snapshot.open) {
    snapshot = { ...snapshot, open: true, navError: null }
    emit()
  }
}

export function closeFooterPopup(): void {
  if (snapshot.open) {
    snapshot = { ...snapshot, open: false }
    emit()
  }
}

export function toggleFooterPopup(): void {
  const opening = !snapshot.open
  snapshot = { ...snapshot, open: opening, navError: opening ? null : snapshot.navError }
  emit()
}

export function setFooterNavError(message: string | null): void {
  if (snapshot.navError !== message) {
    snapshot = { ...snapshot, navError: message }
    emit()
  }
}
