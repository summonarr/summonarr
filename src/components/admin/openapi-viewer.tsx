"use client";

// Admin → API Docs: the served OpenAPI document (GET /api/openapi), grouped by
// tag, each operation expandable to its auth, parameters, body and responses,
// with "Copy as curl". The spec's shape, the labels, the examples and the curl
// command are openapi-viewer-model.ts; this file is the view.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { withBasePath } from "@/lib/base-path";
import { useDelayed } from "@/hooks/use-delayed";
import { useT } from "@/components/i18n/i18n-provider";
import { AlertTriangle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/design";
import { Bar } from "@/components/loading/poster-grid-skeleton";
import { fetchJson } from "@/lib/client/fetch-json";
import {
  OpenApiSpecWire,
  curlCommand,
  exampleValue,
  filterOps,
  firstContent,
  flattenOps,
  groupByTag,
  panelIdFor,
  statusColor,
  typeLabel,
  type FlatOp,
  type OpenApiSpec,
  type Operation,
  type Parameter,
  type Schemas,
  type Security,
} from "@/components/admin/openapi-viewer-model";

// Keyboard focus on the endpoint rows and the copy button; the toggle fills a
// card with overflow:hidden, so its ring has to sit inside the edge to be seen.
const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]";
const FOCUS_RING_INSET = `${FOCUS_RING} focus-visible:ring-inset`;

// "Parameters" / "Request body" / "Responses" headings inside an operation panel.
const SECTION_HEADING: CSSProperties = {
  fontWeight: 600,
  color: "var(--ds-fg)",
  marginBottom: "0.3rem",
};
const SECTION: CSSProperties = { marginBottom: "0.7rem" };

// The request-body example and the revealed curl command.
const CODE_BLOCK: CSSProperties = {
  margin: 0,
  padding: "0.5rem 0.6rem",
  background: "var(--ds-bg)",
  border: "1px solid var(--ds-border)",
  borderRadius: "var(--ds-r-sm)",
  color: "var(--ds-fg-muted)",
  fontSize: 12,
  overflowX: "auto",
};

const COPY_FEEDBACK_MS = 2000;

const METHOD_COLOR: Record<string, string> = {
  get: "var(--ds-info)",
  post: "var(--ds-success)",
  put: "var(--ds-warning)",
  patch: "var(--ds-accent-text)",
  delete: "var(--ds-danger)",
};

const SECURITY_LABEL_KEY: Record<string, string> = {
  session: "adminManage.apiDocs.security.session",
  sessionBearer: "adminManage.apiDocs.security.sessionBearer",
  cronSecret: "adminManage.apiDocs.security.cronSecret",
};

function ParameterList({ parameters }: { parameters: Parameter[] }) {
  const t = useT();
  return (
    <div style={SECTION}>
      <div style={SECTION_HEADING}>{t("adminManage.apiDocs.parameters")}</div>
      {parameters.map((p) => (
        <div key={`${p.in}:${p.name}`} style={{ color: "var(--ds-fg-muted)", padding: "0.1rem 0" }}>
          <code style={{ color: "var(--ds-fg)" }}>{p.name}</code>{" "}
          <span style={{ color: "var(--ds-fg-subtle)" }}>({p.in})</span>{" "}
          {typeLabel(p.schema)}
          {p.required && <span style={{ color: "var(--ds-danger)" }}> · {t("adminManage.apiDocs.required")}</span>}
        </div>
      ))}
    </div>
  );
}

function RequestBodyExample({
  requestBody,
  schemas,
}: {
  requestBody: NonNullable<Operation["requestBody"]>;
  schemas: Schemas;
}) {
  const t = useT();
  // The first body the operation declares: a JSON example, or (a backup upload) the file it takes.
  const body = firstContent(requestBody.content);
  return (
    <div style={SECTION}>
      <div style={SECTION_HEADING}>
        {t("adminManage.apiDocs.requestBody")}
        {requestBody.required && <span style={{ color: "var(--ds-danger)" }}> · {t("adminManage.apiDocs.required")}</span>}
      </div>
      <pre style={CODE_BLOCK}>
        {body && !body.json
          ? t("adminManage.apiDocs.binaryBody", { type: body.type })
          : JSON.stringify(exampleValue(body?.schema, schemas), null, 2)}
      </pre>
    </div>
  );
}

function ResponseList({ responses }: { responses: NonNullable<Operation["responses"]> }) {
  const t = useT();
  return (
    <div style={SECTION}>
      <div style={SECTION_HEADING}>{t("adminManage.apiDocs.responses")}</div>
      {Object.entries(responses).map(([code, resp]) => {
        const content = firstContent(resp.content);
        return (
          <div key={code} style={{ color: "var(--ds-fg-muted)", padding: "0.1rem 0" }}>
            <span style={{ color: statusColor(code), fontWeight: 600 }}>{code}</span> {resp.description}
            {content?.schema !== undefined && (
              <span style={{ color: "var(--ds-fg-subtle)" }}> → {typeLabel(content.schema)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OperationPanel({
  op,
  panelId,
  opLabel,
  schemas,
  securityLabel,
  copied,
  revealedCommand,
  onCopy,
}: {
  op: Operation;
  panelId: string;
  opLabel: string;
  schemas: Schemas;
  securityLabel: string;
  copied: boolean;
  revealedCommand: string | null;
  onCopy: () => void;
}) {
  const t = useT();
  return (
    <div
      id={panelId}
      role="region"
      aria-label={opLabel}
      style={{ padding: "0.75rem 0.9rem", borderTop: "1px solid var(--ds-border)", fontSize: 13 }}
    >
      <div style={{ marginBottom: "0.6rem", color: "var(--ds-fg-muted)" }}>
        <strong style={{ color: "var(--ds-fg)" }}>{t("adminManage.apiDocs.auth")}</strong> {securityLabel}
      </div>

      {op.description && <p style={{ color: "var(--ds-fg-muted)", marginBottom: "0.6rem" }}>{op.description}</p>}

      {op.parameters && op.parameters.length > 0 && <ParameterList parameters={op.parameters} />}

      {op.requestBody && <RequestBodyExample requestBody={op.requestBody} schemas={schemas} />}

      <ResponseList responses={op.responses ?? {}} />

      <button
        type="button"
        onClick={onCopy}
        className={FOCUS_RING}
        style={{
          fontSize: 12,
          padding: "0.3rem 0.7rem",
          background: "var(--ds-accent-soft)",
          color: "var(--ds-accent-text)",
          border: "1px solid var(--ds-accent-ring)",
          borderRadius: "var(--ds-r-sm)",
        }}
      >
        {copied ? t("adminManage.apiDocs.copied") : t("adminManage.apiDocs.copyCurl")}
      </button>

      {revealedCommand !== null && (
        <div style={{ marginTop: "0.5rem" }}>
          <p style={{ color: "var(--ds-warning)", fontSize: 12, margin: "0 0 0.3rem" }}>
            {t("adminManage.apiDocs.clipboardUnavailable")}
          </p>
          <pre style={{ ...CODE_BLOCK, userSelect: "text" }}>{revealedCommand}</pre>
        </div>
      )}
    </div>
  );
}

function OperationRow({
  method,
  path,
  summary,
  isOpen,
  panelId,
  onToggle,
  children,
}: {
  method: string;
  path: string;
  summary: string | undefined;
  isOpen: boolean;
  panelId: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  const color = METHOD_COLOR[method] ?? "var(--ds-fg-subtle)";
  return (
    <div
      style={{
        border: "1px solid var(--ds-border)",
        borderRadius: "var(--ds-r-md)",
        background: "var(--ds-bg-inset)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={FOCUS_RING_INSET}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.6rem",
          width: "100%",
          padding: "0.5rem 0.7rem",
          background: "transparent",
          border: "none",
          textAlign: "left",
        }}
      >
        <span
          style={{
            flexShrink: 0,
            width: 62,
            textAlign: "center",
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            color,
            background: `color-mix(in oklab, ${color} 16%, transparent)`,
            borderRadius: "var(--ds-r-sm)",
            padding: "0.2rem 0",
          }}
        >
          {method}
        </span>
        <code style={{ fontSize: 13, color: "var(--ds-fg)", minWidth: 0, overflowWrap: "anywhere" }}>{path}</code>
        <span style={{ fontSize: 12, color: "var(--ds-fg-muted)", marginLeft: "auto", textAlign: "right" }}>
          {summary}
        </span>
      </button>
      {isOpen && children}
    </div>
  );
}

// The served spec, checked against its shape. Retry re-reads it.
function useOpenApiSpec() {
  const t = useT();
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry; the effect below re-runs the fetch for the new value.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    void fetchJson(withBasePath("/api/openapi"), { schema: OpenApiSpecWire, signal: ctl.signal }).then((res) => {
      if (ctl.signal.aborted) return;
      if (res.ok) setSpec(res.data);
      else setError(res.kind === "http" ? t("adminManage.apiDocs.loadFailedStatus", { status: res.status }) : t("adminManage.apiDocs.loadFailed"));
    });
    return () => ctl.abort();
  }, [t, attempt]);
  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };
  return { spec, error, retry };
}

// "Copy as curl": the clipboard where the browser offers one, else the command
// shown for copying by hand. One reset slot for the "Copied!" label: a second
// copy replaces the first copy's pending reset (so it can't clear the new
// label early), and an unmount cancels it.
function useCurlCopy({ spec, sessionCookieName }: { spec: OpenApiSpec | null; sessionCookieName: string }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ key: string; command: string } | null>(null);
  const clearCopiedLater = useDelayed();

  const copyCurl = async (key: string, method: string, path: string, op: Operation, security: Security) => {
    const command = curlCommand({
      origin: typeof window !== "undefined" ? window.location.origin : "",
      serverUrl: spec?.servers?.[0]?.url ?? withBasePath("/api"),
      method,
      path,
      op,
      security,
      schemas: spec?.components?.schemas ?? {},
      cookieName: sessionCookieName,
    });
    // navigator.clipboard exists only in a secure context, so it is absent on the
    // supported http:// LAN deployment — an unguarded write throws a TypeError
    // straight out of the click handler.
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(command);
      setRevealed(null);
      setCopiedKey(key);
      // Clears only this copy's label, never one a later copy set.
      clearCopiedLater(() => setCopiedKey((k) => (k === key ? null : k)), COPY_FEEDBACK_MS);
    } catch {
      clearCopiedLater.cancel();
      setCopiedKey(null);
      setRevealed({ key, command });
    }
  };
  return { copiedKey, revealed, copyCurl };
}

export function OpenApiViewer({ sessionCookieName }: { sessionCookieName: string }) {
  const t = useT();
  const { spec, error, retry } = useOpenApiSpec();
  const { copiedKey, revealed, copyCurl } = useCurlCopy({ spec, sessionCookieName });
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ops = useMemo<FlatOp[]>(() => (spec ? flattenOps(spec) : []), [spec]);
  const filtered = useMemo(() => filterOps(ops, filter), [ops, filter]);
  const otherLabel = t("adminManage.apiDocs.other");
  const groups = useMemo(() => groupByTag(filtered, spec?.tags ?? [], otherLabel), [filtered, spec, otherLabel]);

  if (error) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <EmptyState
          icon={AlertTriangle}
          description={t("adminManage.apiDocs.loadError", { error })}
          action={
            <Button variant="secondary" size="sm" onClick={retry}>
              {t("adminManage.apiDocs.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!spec) {
    // Four endpoint-row-sized bars so the list lands in roughly the same frame
    // instead of popping in under a single line of text.
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("adminManage.apiDocs.loading")}
        className="flex flex-col"
        style={{ padding: "1.25rem", gap: "0.35rem" }}
      >
        {[0, 1, 2, 3].map((i) => (
          <Bar key={i} w="100%" h={38} r={8} />
        ))}
      </div>
    );
  }

  const globalSecurity = spec.security ?? [];
  const securityLabel = (op: Operation): string => {
    const sec = op.security ?? globalSecurity;
    if (sec.length === 0) return t("adminManage.apiDocs.public");
    const schemes = [...new Set(sec.flatMap((entry) => Object.keys(entry)))];
    return schemes.map((scheme) => (SECURITY_LABEL_KEY[scheme] ? t(SECURITY_LABEL_KEY[scheme]) : scheme)).join(t("adminManage.apiDocs.or"));
  };

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div style={{ padding: "1.25rem" }}>
      {spec.info.description && (
        <p style={{ color: "var(--ds-fg-muted)", marginBottom: "0.5rem", fontSize: 14 }}>
          {spec.info.description}
        </p>
      )}
      <p style={{ color: "var(--ds-fg-subtle)", marginBottom: "1rem", fontSize: 13 }}>
        {spec.info.title} · v{spec.info.version} · {t("adminManage.apiDocs.endpoints", { count: ops.length })}
      </p>

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("adminManage.apiDocs.filterPlaceholder")}
        aria-label={t("adminManage.apiDocs.filter")}
        style={{
          width: "100%",
          padding: "0.5rem 0.75rem",
          marginBottom: "1.25rem",
          background: "var(--ds-bg-inset)",
          border: "1px solid var(--ds-border)",
          borderRadius: "var(--ds-r-md)",
          color: "var(--ds-fg)",
          fontSize: 14,
        }}
      />

      {groups.length === 0 && (
        <p style={{ color: "var(--ds-fg-muted)" }}>{t("adminManage.apiDocs.noMatch", { filter })}</p>
      )}

      {groups.map(({ tag, entries }) => (
        <TagSection key={tag} tag={tag} description={spec.tags?.find((tagMeta) => tagMeta.name === tag)?.description} count={entries.length}>
          {entries.map(({ key, method, path, op }) => {
            const panelId = panelIdFor(key);
            return (
              <OperationRow
                key={key}
                method={method}
                path={path}
                summary={op.summary}
                isOpen={expanded.has(key)}
                panelId={panelId}
                onToggle={() => toggle(key)}
              >
                <OperationPanel
                  op={op}
                  panelId={panelId}
                  opLabel={`${method.toUpperCase()} ${path}`}
                  schemas={spec.components?.schemas ?? {}}
                  securityLabel={securityLabel(op)}
                  copied={copiedKey === key}
                  revealedCommand={revealed?.key === key ? revealed.command : null}
                  onCopy={() => void copyCurl(key, method, path, op, op.security ?? globalSecurity)}
                />
              </OperationRow>
            );
          })}
        </TagSection>
      ))}
    </div>
  );
}

function TagSection({ tag, description, count, children }: { tag: string; description: string | undefined; count: number; children: ReactNode }) {
  return (
    <section style={{ marginBottom: "1.75rem" }}>
      <h3
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--ds-fg)",
          borderBottom: "1px solid var(--ds-border)",
          paddingBottom: "0.35rem",
          marginBottom: "0.6rem",
        }}
      >
        {tag}
        <span style={{ color: "var(--ds-fg-subtle)", fontWeight: 400 }}>
          {" "}
          · {count}
        </span>
      </h3>
      {description && (
        <p style={{ color: "var(--ds-fg-muted)", fontSize: 13, marginBottom: "0.6rem" }}>
          {description}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        {children}
      </div>
    </section>
  );
}
