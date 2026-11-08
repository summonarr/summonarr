// The OpenAPI 3.0 subset the document (./spec.ts and ./paths/*) uses, checked
// at compile time — each area module is typed `OpenApiPaths`, each fragment
// `satisfies` its type — so a misspelled key (`requestbody`, `nullabe`), a
// misplaced `required` or a status code that isn't one fails typecheck instead of
// shipping. Type-only, so the served JSON is exactly the object literals. Extend
// it when the spec needs a keyword it doesn't list yet.
export type OpenApiSchema = {
  $ref?: string;
  type?: "string" | "integer" | "number" | "boolean" | "array" | "object";
  format?: string;
  description?: string;
  nullable?: boolean;
  deprecated?: boolean;
  // A request-only field (a secret the server never sends back) or a
  // response-only one, so a generated client keeps it out of the other model.
  readOnly?: boolean;
  writeOnly?: boolean;
  enum?: readonly unknown[];
  default?: unknown;
  example?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  required?: readonly string[];
  allOf?: readonly OpenApiSchema[];
  oneOf?: readonly OpenApiSchema[];
  anyOf?: readonly OpenApiSchema[];
};
export type OpenApiMedia = { schema?: OpenApiSchema; example?: unknown };
export type OpenApiResponse = {
  description: string;
  headers?: Record<string, { description?: string; schema?: OpenApiSchema }>;
  content?: Record<string, OpenApiMedia>;
};
export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type OpenApiResponses = Partial<Record<`${1 | 2 | 3 | 4 | 5}${Digit}${Digit}` | "default", OpenApiResponse>>;
export type OpenApiParameter = {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: OpenApiSchema;
};
export type OpenApiSecurity = readonly Record<string, readonly string[]>[];
export type OpenApiOperation = {
  tags?: readonly string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  security?: OpenApiSecurity;
  parameters?: readonly OpenApiParameter[];
  requestBody?: { description?: string; required?: boolean; content: Record<string, OpenApiMedia> };
  responses: OpenApiResponses;
};
export type OpenApiDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string; description?: string };
  servers: readonly { url: string; description?: string }[];
  components: {
    securitySchemes: Record<string, {
      type: "apiKey" | "http";
      in?: "query" | "header" | "cookie";
      name?: string;
      scheme?: string;
      bearerFormat?: string;
      description?: string;
    }>;
    schemas: Record<string, OpenApiSchema>;
  };
  security: OpenApiSecurity;
  tags: readonly { name: string; description?: string }[];
  paths: Record<string, Partial<Record<"get" | "post" | "put" | "patch" | "delete", OpenApiOperation>>>;
};
// One area module of the document (./paths/*): its paths and their operations.
export type OpenApiPaths = OpenApiDocument["paths"];
