"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type ImageStatus = "idle" | "loaded" | "error"

const AvatarContext = React.createContext<{
  status: ImageStatus
  setStatus: (s: ImageStatus) => void
} | null>(null)

function useAvatarContext(component: string) {
  const ctx = React.useContext(AvatarContext)
  if (!ctx) throw new Error(`${component} must be a child of <Avatar>`)
  return ctx
}

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"span"> & {
  size?: "default" | "sm" | "lg"
}) {
  const [status, setStatus] = React.useState<ImageStatus>("idle")
  const value = React.useMemo(() => ({ status, setStatus }), [status])
  return (
    <AvatarContext.Provider value={value}>
      <span
        data-slot="avatar"
        data-size={size}
        className={cn(
          "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
          className
        )}
        {...props}
      />
    </AvatarContext.Provider>
  )
}

function AvatarImage({
  className,
  onLoad,
  onError,
  ...props
}: React.ComponentProps<"img">) {
  const { status, setStatus } = useAvatarContext("AvatarImage")
  if (status === "error") return null
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-slot="avatar-image"
      alt={props.alt ?? ""}
      className={cn(
        "aspect-square size-full rounded-full object-cover",
        className
      )}
      onLoad={(e) => {
        setStatus("loaded")
        onLoad?.(e)
      }}
      onError={(e) => {
        setStatus("error")
        onError?.(e)
      }}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const { status } = useAvatarContext("AvatarFallback")
  // Only render once the image has failed (or no <AvatarImage> child exists).
  // Matches base-ui's "fallback hides while image is loading/loaded" behaviour
  // so an avatar with a valid src doesn't flash initials before the image paints.
  if (status === "loaded") return null
  return (
    <span
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
}
