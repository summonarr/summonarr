// Maps a raw DB error to an actionable "run prisma db push" hint when trash tables/enum values are missing; null otherwise.
export function describeSchemaError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const message = err.message;
  if (/relation "(public\.)?"?Trash(Spec|Application)"? does not exist/i.test(message)) {
    return (
      "TrashSpec/TrashApplication tables are missing in the database. " +
      "Run `npx prisma db push` against DATABASE_URL to apply the schema " +
      "(the production entrypoint does this on container start — rebuild + restart)."
    );
  }
  if ((err as { code?: string }).code === "42P01") {
    return (
      "A Postgres relation referenced by trash-sync does not exist yet. " +
      "Run `npx prisma db push` to apply the latest schema."
    );
  }
  if (/invalid input value for enum.*TrashSpecKind.*CUSTOM_FORMAT_GROUP/i.test(message)) {
    return (
      "TrashSpecKind enum is missing CUSTOM_FORMAT_GROUP. Run `npx prisma db push` " +
      "to add the new enum value before refreshing CF-Groups."
    );
  }
  return null;
}
