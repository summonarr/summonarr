// Source-scan helpers for the structural pins (imported by tests; not itself a
// test file — the runner's glob is tests/*.test.mts).
//
// Why: a pin that cuts a function out of a file with a fixed character window
// (`src.slice(i, i + 1800)`) stops short of the function's tail as the code
// grows, so a `doesNotMatch` over the window passes without ever looking at
// the end of the function. These cut at the MATCHING bracket instead, and
// skip comments, string literals and template text while counting brackets,
// so a brace inside a string or a comment can't end the cut early.
//
// Not a JS parser: a regex literal holding a quote or a bracket can confuse
// it. A miscount throws instead of returning a short cut — a confused scan
// fails the pin, it never passes it vacuously.
import assert from "node:assert/strict";

/**
 * `src` with every comment blanked to spaces (newlines kept, so indices still
 * line up with `src`). With `blankText`, the contents of string literals and
 * the TEXT of template literals are blanked too (a template's `${…}`
 * expressions stay code).
 */
export function maskSource(src: string, opts: { blankText?: boolean } = {}): string {
  const out = src.split("");
  const blank = (i: number) => { if (out[i] !== "\n") out[i] = " "; };
  const blankText = opts.blankText === true;
  // One entry per open `${`: how many `{` are open inside that expression.
  const exprDepth: number[] = [];
  let inTemplateText = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inTemplateText) {
      if (c === "\\") { if (blankText) { blank(i); blank(i + 1); } i += 2; continue; }
      if (c === "`") { inTemplateText = false; i++; continue; }
      if (c === "$" && n === "{") { exprDepth.push(0); inTemplateText = false; i += 2; continue; }
      if (blankText) blank(i);
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (blankText) for (let k = i + 1; k < j && k < src.length; k++) blank(k);
      i = j + 1;
      continue;
    }
    if (c === "`") { inTemplateText = true; i++; continue; }
    if (exprDepth.length > 0) {
      const top = exprDepth.length - 1;
      if (c === "{") exprDepth[top]++;
      else if (c === "}") {
        if (exprDepth[top] === 0) { exprDepth.pop(); inTemplateText = true; i++; continue; }
        exprDepth[top]--;
      }
    }
    i++;
  }
  return out.join("");
}

/** `src` with its comments blanked — for scanning code (and its literals) only. */
export const stripComments = (src: string): string => maskSource(src);

const CLOSER: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

/**
 * Index of the bracket closing the one at `open`, counted over `masked`
 * (`maskSource(src, { blankText: true })`, so indices are `src`'s). Throws on
 * a mismatched or unclosed bracket.
 */
export function closingBracket(masked: string, open: number): number {
  assert.ok(CLOSER[masked[open]] !== undefined, `no bracket at ${open}: ${JSON.stringify(masked.slice(open, open + 20))}`);
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (CLOSER[c] !== undefined) stack.push(CLOSER[c]);
    else if (c === "}" || c === ")" || c === "]") {
      const want = stack.pop();
      if (c !== want) throw new Error(`unbalanced source at ${i}: wanted ${want}, found ${c}`);
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`unclosed ${masked[open]} at ${open}`);
}

/**
 * The [start, end) range of the BODY of the function declared at `anchor`
 * (e.g. "async function replace(") — from just inside its opening `{` to its
 * matching `}`. The parameter list is skipped as a unit, so a default value
 * or a destructured parameter can't be mistaken for the body.
 */
export function functionBodyRange(src: string, anchor: string, from = 0): [number, number] {
  const at = src.indexOf(anchor, from);
  assert.ok(at >= 0, `${anchor} not found`);
  const masked = maskSource(src, { blankText: true });
  const paren = masked.indexOf("(", at);
  assert.ok(paren >= 0, `${anchor}: no parameter list`);
  const brace = masked.indexOf("{", closingBracket(masked, paren));
  assert.ok(brace >= 0, `${anchor}: no body`);
  return [brace + 1, closingBracket(masked, brace)];
}

/** The text of the body of the function declared at `anchor` (see functionBodyRange). */
export function functionBody(src: string, anchor: string, from = 0): string {
  const [start, end] = functionBodyRange(src, anchor, from);
  return src.slice(start, end);
}

/**
 * Every call of a function whose name matches `name` (a regex source, e.g.
 * "arrFetch\\w*"), with its whole argument list — the balanced `( … )`,
 * however many lines or nested objects it spans, type arguments skipped.
 */
export function callsOf(src: string, name: string): Array<{ index: number; args: string }> {
  const masked = maskSource(src, { blankText: true });
  const code = stripComments(src);
  const out: Array<{ index: number; args: string }> = [];
  for (const m of masked.matchAll(new RegExp(`\\b(?:${name})\\b`, "g"))) {
    let i = m.index + m[0].length;
    while (/\s/.test(masked[i] ?? "")) i++;
    if (masked[i] === "<") {
      // Type arguments: skip to the matching `>` (an arrow's `=>` is not one).
      let depth = 0;
      for (; i < masked.length; i++) {
        if (masked[i] === "<") depth++;
        else if (masked[i] === ">" && masked[i - 1] !== "=" && --depth === 0) { i++; break; }
      }
      while (/\s/.test(masked[i] ?? "")) i++;
    }
    if (masked[i] !== "(") continue;
    out.push({ index: m.index, args: code.slice(i + 1, closingBracket(masked, i)) });
  }
  return out;
}
