"use client"

import {
  CheckCircle,
  Info,
  SpinnerGap,
  Warning,
  XCircle,
} from "@phosphor-icons/react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "!border-[var(--color-border-soft)] !bg-[var(--color-bg-surface)] !text-[var(--color-text-primary)]",
          title: "!text-[var(--color-text-primary)]",
          description: "!text-[var(--color-text-secondary)]",
          actionButton: "!bg-[var(--color-accent-solid)] !text-[var(--color-on-accent)]",
          cancelButton: "!bg-[var(--color-bg-hover)] !text-[var(--color-text-primary)]",
          closeButton: "!border-[#45454c] !bg-[var(--color-bg-raised)] !text-[var(--color-text-primary)]",
        },
      }}
      icons={{
        success: <CheckCircle size={16} weight="fill" className="size-4" />,
        info: <Info size={16} weight="fill" className="size-4" />,
        warning: <Warning size={16} weight="fill" className="size-4" />,
        error: <XCircle size={16} weight="fill" className="size-4" />,
        loading: <SpinnerGap size={16} weight="fill" className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "#f5f1e8",
          "--normal-text": "#f4f4f5",
          "--normal-border": "#2a2a30",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
