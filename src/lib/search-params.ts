// A page's `searchParams` prop, typed the way Next 16 delivers it: a repeated
// key (`?page=2&page=3`) arrives as an ARRAY at runtime, whatever the declared
// type says. Declaring `Record<string, string>` hid that from the compiler, so
// an array reached parsers that only ever expected a string.
export type PageSearchParams = Record<string, string | string[] | undefined>;

// The first value of a repeated key, the way URLSearchParams.get() reads one.
export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// A `get(key)` over the prop, for the shared parsers that take one (the same
// shape as URLSearchParams.get, so a route and its page parse alike).
export function searchParamGetter(sp: PageSearchParams): (key: string) => string | undefined {
  return (key) => first(sp[key]);
}
