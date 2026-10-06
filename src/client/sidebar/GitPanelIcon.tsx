import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export function GitPanelIcon({ size, active }: PropsRuntime<'sidebar.panellist'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      opacity={active ? 1 : 0.85}
    >
      <circle cx="4.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 6v4M4.5 8c0-1.5 2-1.2 3.4-1.6 1-.3 1.9-.8 2.2-1.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
