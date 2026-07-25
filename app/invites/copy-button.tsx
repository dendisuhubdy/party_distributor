'use client'

import { useState } from 'react'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
