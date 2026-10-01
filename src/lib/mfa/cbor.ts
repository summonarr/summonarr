// Minimal, STRICT CBOR (RFC 8949) decoder — exactly what WebAuthn needs and
// nothing more: the attestationObject, the COSE_Key inside attested credential
// data, and authenticator extension maps. Pure, zero-import.
//
// Strict means every input this doesn't understand is REFUSED, not guessed at:
//   - indefinite-length items, tags, floats and unassigned simple values throw
//     (none appear in CTAP2 canonical output);
//   - lengths are bounds-checked against the remaining input before any read;
//   - map keys must be integers or text, and a duplicate key throws (a parser
//     that kept "the last one" could be steered by an attacker-appended key);
//   - text must be valid UTF-8;
//   - nesting depth and item counts are capped, so a hostile 2 KB blob can't
//     allocate gigabytes or blow the stack.
// decodeCborFirst reports how many bytes the first item used — authenticator
// data embeds a COSE key followed by more data, and the caller needs to know
// where it ends.

export type CborValue =
  | number
  | Uint8Array
  | string
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<number | string, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface State {
  data: Uint8Array;
  pos: number;
  items: number;
}

function need(s: State, n: number): void {
  if (n < 0 || s.pos + n > s.data.length) throw new CborError("unexpected end of CBOR input");
}

function readUint(s: State, n: 1 | 2 | 4 | 8): number {
  need(s, n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = v * 256 + s.data[s.pos + i];
  }
  s.pos += n;
  if (!Number.isSafeInteger(v)) throw new CborError("CBOR integer exceeds the safe range");
  return v;
}

// Reads the argument for major types 0–5 given the 5-bit additional info.
function readArgument(s: State, ai: number): number {
  if (ai < 24) return ai;
  if (ai === 24) return readUint(s, 1);
  if (ai === 25) return readUint(s, 2);
  if (ai === 26) return readUint(s, 4);
  if (ai === 27) return readUint(s, 8);
  if (ai === 31) throw new CborError("indefinite-length CBOR items are not accepted");
  throw new CborError(`reserved CBOR additional info ${ai}`);
}

function decodeItem(s: State, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError("CBOR nesting too deep");
  if (++s.items > MAX_ITEMS) throw new CborError("too many CBOR items");
  need(s, 1);
  const initial = s.data[s.pos++];
  const major = initial >> 5;
  const ai = initial & 0x1f;

  switch (major) {
    case 0: // unsigned integer
      return readArgument(s, ai);
    case 1: // negative integer: -1 - n
      return -1 - readArgument(s, ai);
    case 2: { // byte string
      const len = readArgument(s, ai);
      need(s, len);
      const out = s.data.slice(s.pos, s.pos + len);
      s.pos += len;
      return out;
    }
    case 3: { // text string
      const len = readArgument(s, ai);
      need(s, len);
      let text: string;
      try {
        text = UTF8.decode(s.data.subarray(s.pos, s.pos + len));
      } catch {
        throw new CborError("CBOR text string is not valid UTF-8");
      }
      s.pos += len;
      return text;
    }
    case 4: { // array
      const len = readArgument(s, ai);
      if (len > MAX_ITEMS) throw new CborError("CBOR array too long");
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) arr.push(decodeItem(s, depth + 1));
      return arr;
    }
    case 5: { // map
      const len = readArgument(s, ai);
      if (len > MAX_ITEMS) throw new CborError("CBOR map too long");
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < len; i++) {
        const key = decodeItem(s, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") {
          throw new CborError("CBOR map keys must be integers or text");
        }
        if (map.has(key)) throw new CborError("duplicate CBOR map key");
        map.set(key, decodeItem(s, depth + 1));
      }
      return map;
    }
    case 6:
      throw new CborError("CBOR tags are not accepted");
    case 7:
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      throw new CborError("CBOR floats and unassigned simple values are not accepted");
    default:
      throw new CborError("invalid CBOR major type");
  }
}

// Decodes the first item; returns it with the number of bytes it occupied.
export function decodeCborFirst(data: Uint8Array): { value: CborValue; length: number } {
  const s: State = { data, pos: 0, items: 0 };
  const value = decodeItem(s, 0);
  return { value, length: s.pos };
}

// Decodes exactly one item and refuses trailing bytes.
export function decodeCbor(data: Uint8Array): CborValue {
  const { value, length } = decodeCborFirst(data);
  if (length !== data.length) throw new CborError("trailing bytes after CBOR item");
  return value;
}

export function isCborMap(v: CborValue): v is Map<number | string, CborValue> {
  return v instanceof Map;
}
