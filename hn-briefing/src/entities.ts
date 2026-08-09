/**
 * Minimal HTML entity decoder — handles the common named entities and all
 * numeric (decimal/hex) references. Zero-dependency.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  middot: "·",
  times: "×",
  divide: "÷",
  plusmn: "±",
  le: "≤",
  ge: "≥",
  ne: "≠",
  infin: "∞",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  pi: "π",
  lambda: "λ",
  mu: "μ",
  sum: "∑",
  prod: "∏",
  radic: "√",
  int: "∫",
  deg: "°",
  prime: "′",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  micro: "µ",
  sup2: "²",
  sup3: "³",
};

export function decode(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    return NAMED[body] ?? m;
  });
}