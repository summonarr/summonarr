"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { cn } from "@/lib/utils";

function Drawer({ swipeDirection = "down", ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" swipeDirection={swipeDirection} {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerBackdrop({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
        className
      )}
      {...props}
    />
  );
}

function DrawerPopup({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPrimitive.Popup
      data-slot="drawer-popup"
      className={cn(
        "fixed bottom-0 inset-x-0 z-50 flex flex-col max-h-[85vh] rounded-t-2xl bg-zinc-900 border-t border-zinc-800 shadow-2xl outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full",
        className
      )}
      {...props}
    >
      <div className="flex justify-center pt-3 pb-1 shrink-0">
        <div className="w-12 h-1 rounded-full bg-zinc-600" />
      </div>
      {children}
    </DrawerPrimitive.Popup>
  );
}

function DrawerContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="drawer-content"
      className={cn("flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]", className)}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("sr-only", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("sr-only", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerTrigger,
  DrawerClose,
  DrawerBackdrop,
  DrawerPopup,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
};
