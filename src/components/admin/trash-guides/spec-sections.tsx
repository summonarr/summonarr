"use client";

import { SpecSection, useSpecStatus } from "./spec-section";
import type { TrashService, TrashSpecKind } from "./types";

export interface SpecSectionSpec {
  kind: TrashSpecKind;
  title: string;
  description: string;
}

// Several SpecSections on one page share ONE /status fetch — the endpoint
// returns every kind, so two uncontrolled sections requested the identical
// payload twice on load and again after every apply/pause/forget, and the
// section that did not act kept stale counts until a reload. The shared
// `reload` refreshes both at once.
export function SpecSections({
  service,
  variant,
  disabled,
  sections,
}: {
  service: TrashService;
  variant: string;
  disabled: boolean;
  sections: SpecSectionSpec[];
}) {
  const status = useSpecStatus(service, variant);
  return (
    <>
      {sections.map((s) => (
        <SpecSection
          key={`${s.kind}-${service}-${variant || "default"}`}
          service={service}
          variant={variant}
          kind={s.kind}
          title={s.title}
          description={s.description}
          disabled={disabled}
          status={status}
        />
      ))}
    </>
  );
}
