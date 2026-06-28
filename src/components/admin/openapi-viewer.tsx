"use client";

import { useEffect, useMemo, useState } from "react";
import { withBasePath } from "@/lib/base-path";

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  allOf?: SchemaObject[];
  default?: unknown;
  description?: string;
  maxLength?: number;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
}

interface MediaContent {
  schema?: SchemaObject;
}

interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaContent> };
  responses?: Record<string, { description?: string; content?: Record<string, MediaContent> }>;
}

interface OpenApiSpec {
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, SchemaObject> };
  security?: Record<string, string[]>[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const METHOD_COLOR: Record<string, string> = {
  get: "var(--ds-info)",
  post: "var(--ds-success)",
  put: "var(--ds-warning)",
  patch: "var(--ds-accent)",
  delete: "var(--ds-danger)",
};

const SECURITY_LABEL: Record<string, string> = {
  session: "Session cookie",
  cronSecret: "CRON_SECRET bearer",
};

function stripRef(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

function resolveSchema(
  schema: SchemaObject | undefined,
  schemas: Record<string, SchemaObject>,
): SchemaObject | undefined {
  if (!schema) return undefined;
  if (schema.$ref) return resolveSchema(schemas[stripRef(schema.$ref)], schemas);
  return schema;
}

function typeLabel(schema: SchemaObject | undefined): string {
  if (!schema) return "—";
  if (schema.$ref) return stripRef(schema.$ref);
  if (schema.allOf) return schema.allOf.map(typeLabel).join(" & ");
  if (schema.enum) return schema.enum.map(String).join(" | ");
  if (schema.type === "array") return `${typeLabel(schema.items)}[]`;
  let t = schema.type ?? "object";
  if (schema.format) t += `<${schema.format}>`;
  if (schema.nullable) t += " | null";
  return t;
}

function exampleValue(
  schema: SchemaObject | undefined,
  schemas: Record<string, SchemaObject>,
): unknown {
  const s = resolveSchema(schema, schemas);
  if (!s) return null;
  if (s.enum) return s.enum[0];
  if (s.allOf) {
    return Object.assign({}, ...s.allOf.map((part) => exampleValue(part, schemas)));
  }
  switch (s.type) {
    case "string":
      return s.format === "date-time" ? "2024-01-01T00:00:00Z" : "string";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    case "array":
      return [exampleValue(s.items, schemas)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(s.properties ?? {})) {
        out[key] = exampleValue(value, schemas);
      }
      return out;
    }
    default:
      return null;
  }
}

function statusColor(code: string): string {
  if (code.startsWith("2")) return "var(--ds-success)";
  if (code.startsWith("4")) return "var(--ds-warning)";
  if (code.startsWith("5")) return "var(--ds-danger)";
  return "var(--ds-fg-subtle)";
}

interface FlatOp {
  key: string;
  method: string;
  path: string;
  op: Operation;
}

export function OpenApiViewer() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(withBasePath("/api/openapi"))
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load spec (${res.status})`);
        return res.json();
      })
      .then((data: OpenApiSpec) => {
        if (!cancelled) setSpec(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load spec");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ops = useMemo<FlatOp[]>(() => {
    if (!spec) return [];
    const flat: FlatOp[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const op = methods[method];
        if (op) flat.push({ key: `${method} ${path}`, method, path, op });
      }
    }
    return flat;
  }, [spec]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return ops;
    return ops.filter(
      ({ path, op }) =>
        path.toLowerCase().includes(needle) ||
        (op.summary ?? "").toLowerCase().includes(needle),
    );
  }, [ops, filter]);

  if (error) {
    return (
      <div style={{ padding: "1.5rem", color: "var(--ds-danger)" }}>
        Could not load the API spec: {error}
      </div>
    );
  }

  if (!spec) {
    return (
      <div style={{ padding: "1.5rem", color: "var(--ds-fg-muted)" }}>Loading API spec…</div>
    );
  }

  const schemas = spec.components?.schemas ?? {};
  const globalSecurity = spec.security ?? [];
  const serverUrl = spec.servers?.[0]?.url ?? "/api";

  const securityLabel = (op: Operation): string => {
    const sec = op.security ?? globalSecurity;
    if (sec.length === 0) return "Public";
    const schemes = [...new Set(sec.flatMap((entry) => Object.keys(entry)))];
    return schemes.map((s) => SECURITY_LABEL[s] ?? s).join(" or ");
  };

  const copyCurl = (method: string, path: string, op: Operation) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // Substitute {id}-style path params with an uppercase placeholder the user
    // replaces, rather than leaving the literal brace syntax in the URL.
    const resolvedPath = path.replace(/\{(\w+)\}/g, (_, name: string) => name.toUpperCase());
    const query = (op.parameters ?? [])
      .filter((p) => p.in === "query")
      .map((p) => `${p.name}=`)
      .join("&");
    const url = `${origin}${serverUrl}${resolvedPath}${query ? `?${query}` : ""}`;
    const lines = [`curl -X ${method.toUpperCase()} '${url}'`];
    const sec = op.security ?? globalSecurity;
    if (sec.length > 0) {
      // The `__Host-` prefix only applies over HTTPS; an HTTP (dev) instance
      // carries the unprefixed cookie name, matching getSessionCookieName().
      const cookieName =
        typeof window !== "undefined" && window.location.protocol !== "https:"
          ? "summonarr-session"
          : "__Host-summonarr-session";
      lines.push(`  --cookie '${cookieName}=YOUR_SESSION_TOKEN'`);
    }
    const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
    if (bodySchema) {
      const example = exampleValue(bodySchema, schemas);
      lines.push(`  -H 'Content-Type: application/json'`);
      lines.push(`  -d '${JSON.stringify(example)}'`);
    }
    const command = lines.join(" \\\n");
    void navigator.clipboard.writeText(command).then(() => {
      setCopiedKey(`${method} ${path}`);
      window.setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const tagOrder = (spec.tags ?? []).map((t) => t.name);
  const groups = new Map<string, FlatOp[]>();
  for (const entry of filtered) {
    const tag = entry.op.tags?.[0] ?? "Other";
    const bucket = groups.get(tag);
    if (bucket) bucket.push(entry);
    else groups.set(tag, [entry]);
  }
  const orderedTags = [
    ...tagOrder.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !tagOrder.includes(t)),
  ];

  return (
    <div style={{ padding: "1.25rem" }}>
      {spec.info.description && (
        <p style={{ color: "var(--ds-fg-muted)", marginBottom: "0.5rem", fontSize: 14 }}>
          {spec.info.description}
        </p>
      )}
      <p style={{ color: "var(--ds-fg-subtle)", marginBottom: "1rem", fontSize: 13 }}>
        {spec.info.title} · v{spec.info.version} · {ops.length} endpoints
      </p>

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter endpoints by path or summary…"
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

      {orderedTags.length === 0 && (
        <p style={{ color: "var(--ds-fg-muted)" }}>No endpoints match “{filter}”.</p>
      )}

      {orderedTags.map((tag) => {
        const entries = groups.get(tag) ?? [];
        const meta = spec.tags?.find((t) => t.name === tag);
        return (
          <section key={tag} style={{ marginBottom: "1.75rem" }}>
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
                · {entries.length}
              </span>
            </h3>
            {meta?.description && (
              <p style={{ color: "var(--ds-fg-muted)", fontSize: 13, marginBottom: "0.6rem" }}>
                {meta.description}
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              {entries.map(({ key, method, path, op }) => {
                const isOpen = expanded.has(key);
                const color = METHOD_COLOR[method] ?? "var(--ds-fg-subtle)";
                return (
                  <div
                    key={key}
                    style={{
                      border: "1px solid var(--ds-border)",
                      borderRadius: "var(--ds-r-md)",
                      background: "var(--ds-bg-inset)",
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.6rem",
                        width: "100%",
                        padding: "0.5rem 0.7rem",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
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
                      <code style={{ fontSize: 13, color: "var(--ds-fg)" }}>{path}</code>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--ds-fg-muted)",
                          marginLeft: "auto",
                          textAlign: "right",
                        }}
                      >
                        {op.summary}
                      </span>
                    </button>

                    {isOpen && (
                      <div
                        style={{
                          padding: "0.75rem 0.9rem",
                          borderTop: "1px solid var(--ds-border)",
                          fontSize: 13,
                        }}
                      >
                        <div style={{ marginBottom: "0.6rem", color: "var(--ds-fg-muted)" }}>
                          <strong style={{ color: "var(--ds-fg)" }}>Auth:</strong>{" "}
                          {securityLabel(op)}
                        </div>

                        {op.description && (
                          <p style={{ color: "var(--ds-fg-muted)", marginBottom: "0.6rem" }}>
                            {op.description}
                          </p>
                        )}

                        {op.parameters && op.parameters.length > 0 && (
                          <div style={{ marginBottom: "0.7rem" }}>
                            <div
                              style={{
                                fontWeight: 600,
                                color: "var(--ds-fg)",
                                marginBottom: "0.3rem",
                              }}
                            >
                              Parameters
                            </div>
                            {op.parameters.map((p) => (
                              <div
                                key={`${p.in}:${p.name}`}
                                style={{ color: "var(--ds-fg-muted)", padding: "0.1rem 0" }}
                              >
                                <code style={{ color: "var(--ds-fg)" }}>{p.name}</code>{" "}
                                <span style={{ color: "var(--ds-fg-subtle)" }}>({p.in})</span>{" "}
                                {typeLabel(p.schema)}
                                {p.required && (
                                  <span style={{ color: "var(--ds-danger)" }}> · required</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {op.requestBody && (
                          <div style={{ marginBottom: "0.7rem" }}>
                            <div
                              style={{
                                fontWeight: 600,
                                color: "var(--ds-fg)",
                                marginBottom: "0.3rem",
                              }}
                            >
                              Request body
                              {op.requestBody.required && (
                                <span style={{ color: "var(--ds-danger)" }}> · required</span>
                              )}
                            </div>
                            <pre
                              style={{
                                margin: 0,
                                padding: "0.5rem 0.6rem",
                                background: "var(--ds-bg)",
                                border: "1px solid var(--ds-border)",
                                borderRadius: "var(--ds-r-sm)",
                                color: "var(--ds-fg-muted)",
                                fontSize: 12,
                                overflowX: "auto",
                              }}
                            >
                              {JSON.stringify(
                                exampleValue(
                                  op.requestBody.content?.["application/json"]?.schema,
                                  schemas,
                                ),
                                null,
                                2,
                              )}
                            </pre>
                          </div>
                        )}

                        <div style={{ marginBottom: "0.7rem" }}>
                          <div
                            style={{
                              fontWeight: 600,
                              color: "var(--ds-fg)",
                              marginBottom: "0.3rem",
                            }}
                          >
                            Responses
                          </div>
                          {Object.entries(op.responses ?? {}).map(([code, resp]) => (
                            <div
                              key={code}
                              style={{ color: "var(--ds-fg-muted)", padding: "0.1rem 0" }}
                            >
                              <span style={{ color: statusColor(code), fontWeight: 600 }}>
                                {code}
                              </span>{" "}
                              {resp.description}
                              {resp.content?.["application/json"]?.schema && (
                                <span style={{ color: "var(--ds-fg-subtle)" }}>
                                  {" "}
                                  →{" "}
                                  {typeLabel(resp.content["application/json"].schema)}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>

                        <button
                          type="button"
                          onClick={() => copyCurl(method, path, op)}
                          style={{
                            fontSize: 12,
                            padding: "0.3rem 0.7rem",
                            background: "var(--ds-accent-soft)",
                            color: "var(--ds-accent)",
                            border: "1px solid var(--ds-accent-ring)",
                            borderRadius: "var(--ds-r-sm)",
                            cursor: "pointer",
                          }}
                        >
                          {copiedKey === key ? "Copied!" : "Copy as curl"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
