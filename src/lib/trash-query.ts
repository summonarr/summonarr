// Read side for the admin TRaSH page: the catalog with each spec's application
// status on one instance.
import { prisma } from "./prisma";
import type { ArrVariant } from "./arr";
import { toArrInstance } from "./trash-apply-common";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";

export interface SpecApplicationStatus {
  id: string;
  enabled: boolean;
  remoteId: number | null;
  appliedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  errorCount: number;
}

export interface SpecStatus {
  id: string;
  service: TrashService;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  description: string | null;
  fetchedAt: string;
  application: SpecApplicationStatus | null;
}

export interface SpecDetail extends SpecStatus {
  upstreamPath: string;
  upstreamSha: string | null;
  payload: unknown;
}

const APPLICATION_STATUS_SELECT = {
  id: true,
  enabled: true,
  remoteId: true,
  appliedAt: true,
  lastError: true,
  lastErrorAt: true,
  errorCount: true,
} as const;

type ApplicationRow = {
  id: string;
  enabled: boolean;
  remoteId: number | null;
  appliedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  errorCount: number;
};

function toApplicationStatus(app: ApplicationRow | undefined): SpecApplicationStatus | null {
  if (!app) return null;
  return {
    id: app.id,
    enabled: app.enabled,
    remoteId: app.remoteId,
    appliedAt: app.appliedAt?.toISOString() ?? null,
    lastError: app.lastError,
    lastErrorAt: app.lastErrorAt?.toISOString() ?? null,
    errorCount: app.errorCount,
  };
}

type SpecStatusRow = {
  id: string;
  service: TrashService;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  description: string | null;
  fetchedAt: Date;
  applications: ApplicationRow[];
};

function toSpecStatus(r: SpecStatusRow): SpecStatus {
  return {
    id: r.id,
    service: r.service,
    kind: r.kind,
    trashId: r.trashId,
    name: r.name,
    description: r.description,
    fetchedAt: r.fetchedAt.toISOString(),
    application: toApplicationStatus(r.applications[0]),
  };
}

// Lists all specs for a service with their per-variant application status, for the admin trash-guides UI.
export async function listSpecs(service: TrashService, variant: ArrVariant = "hd"): Promise<SpecStatus[]> {
  // Every column the status needs and no payload: the list covers the whole
  // catalog (hundreds of custom formats), and none of their JSON is returned.
  const rows = await prisma.trashSpec.findMany({
    where: { service },
    select: {
      id: true,
      service: true,
      kind: true,
      trashId: true,
      name: true,
      description: true,
      fetchedAt: true,
      applications: {
        where: { arrInstance: toArrInstance(variant) },
        select: APPLICATION_STATUS_SELECT,
      },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map(toSpecStatus);
}

// Returns one spec including its full upstream payload + per-variant application status, for the spec detail view.
export async function getSpecDetail(id: string, variant: ArrVariant = "hd"): Promise<SpecDetail | null> {
  const row = await prisma.trashSpec.findUnique({
    where: { id },
    include: { applications: { where: { arrInstance: toArrInstance(variant) } } },
  });
  if (!row) return null;
  // The status's keys first, as the route has always answered them.
  const { application, ...status } = toSpecStatus(row);
  return {
    ...status,
    upstreamPath: row.upstreamPath,
    upstreamSha: row.upstreamSha,
    payload: row.payload,
    application,
  };
}
