// The spec's domain enums are literal lists; a value added to the Prisma enum
// must reach the document too, so each list is compared with the generated one.

import { test } from "node:test";
import assert from "node:assert/strict";

const { spec } = await import("../src/lib/openapi/spec.ts");
const prismaEnums = await import("@/generated/prisma");

const schemas = spec.components.schemas as Record<string, { enum?: string[] }>;

const PAIRS: Array<[schema: string, prismaEnum: string]> = [
  ["MediaType", "MediaType"],
  ["RequestStatus", "RequestStatus"],
  ["UserRole", "Role"],
  ["IssueType", "IssueType"],
  ["IssueStatus", "IssueStatus"],
  ["IssueScope", "IssueScope"],
];

for (const [schema, name] of PAIRS) {
  test(`the ${schema} schema lists exactly the values of the ${name} enum`, () => {
    const documented = schemas[schema]?.enum;
    assert.ok(documented, `${schema} has no enum`);
    assert.deepEqual([...documented].sort(), Object.values((prismaEnums as unknown as Record<string, Record<string, string>>)[name]).sort());
  });
}
