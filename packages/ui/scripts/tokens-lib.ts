/* Turns the design system's tokens.json into tokens.css and tokens.ts.
   Light values go on :root and [data-theme="light"], dark values on [data-theme="dark"],
   so a dark section on a light page (and a light screen inside it) switches every token. */

type Themed = { light: string; dark: string };
type Value = string | Themed;

export interface TokensJson {
  name: string;
  color: { tokens: { name: string; value: Value; usage?: string }[] };
  type: {
    families: Record<string, string>;
    groups: {
      name: string;
      family: string;
      styles: { name: string; fontSize: string; lineHeight: number; fontWeight: number; letterSpacing?: string }[];
    }[];
  };
  [group: string]: unknown;
}

interface Token { name: string; value: Value }

const SCALES = ["spacing", "radius", "shadow", "blur", "duration", "easing", "opacity"] as const;
const TS_GROUP: Record<(typeof SCALES)[number], string> = {
  spacing: "space", radius: "radius", shadow: "shadow", blur: "blur", duration: "duration", easing: "easing", opacity: "opacity",
};

function isThemed(v: Value): v is Themed {
  return typeof v === "object" && v !== null && "light" in v && "dark" in v;
}

/** "{ink}" is a reference to another token. */
function resolve(v: string): string {
  return /^\{[a-z0-9-]+\}$/.test(v) ? `var(--${v.slice(1, -1)})` : v;
}

function scale(json: TokensJson, group: string): Token[] {
  const g = json[group] as { tokens?: Token[] } | undefined;
  return g?.tokens ?? [];
}

export function generate(json: TokensJson): { css: string; ts: string } {
  const colors: Token[] = json.color.tokens;
  const light: string[] = [];
  const dark: string[] = [];

  const push = (t: Token) => {
    if (isThemed(t.value)) {
      light.push(`  --${t.name}: ${t.value.light};`);
      dark.push(`  --${t.name}: ${t.value.dark};`);
    } else {
      const v = resolve(t.value);
      light.push(`  --${t.name}: ${v};`);
      /* a reference is computed where it is declared, so it must be declared again inside a dark section */
      if (v !== t.value) dark.push(`  --${t.name}: ${v};`);
    }
  };

  light.push("  /* colour */");
  colors.forEach(push);

  light.push("", "  /* type */");
  for (const [fam, stack] of Object.entries(json.type.families)) light.push(`  --font-${fam}: ${stack};`);
  for (const group of json.type.groups) {
    for (const s of group.styles) {
      const p = `--type-${s.name}`;
      light.push(`  ${p}: ${s.fontWeight} ${s.fontSize}/${s.lineHeight} var(--font-${group.family});`);
      light.push(`  ${p}-size: ${s.fontSize};`);
      light.push(`  ${p}-line-height: ${s.lineHeight};`);
      light.push(`  ${p}-weight: ${s.fontWeight};`);
      light.push(`  ${p}-tracking: ${s.letterSpacing ?? "0"};`);
    }
  }

  for (const g of SCALES) {
    light.push("", `  /* ${g} */`);
    scale(json, g).forEach(push);
  }

  const css = [
    "/* Generated from tokens/tokens.json by scripts/gen-tokens.ts. Do not edit by hand. */",
    "",
    ":root,",
    '[data-theme="light"] {',
    ...light,
    "}",
    "",
    '[data-theme="dark"] {',
    ...dark,
    "}",
    "",
  ].join("\n");

  /* tokens.ts: the same values, typed */
  const obj = (list: Token[]) =>
    "{\n" + list.map((t) => `  ${JSON.stringify(t.name)}: ${JSON.stringify(t.value)},`).join("\n") + "\n}";
  const typeStyles = json.type.groups.flatMap((g) =>
    g.styles.map((s) => ({ name: s.name, family: g.family, fontSize: s.fontSize, lineHeight: s.lineHeight, fontWeight: s.fontWeight, letterSpacing: s.letterSpacing ?? "0" })),
  );
  const ts = [
    "/* Generated from tokens/tokens.json by scripts/gen-tokens.ts. Do not edit by hand. */",
    "",
    "export type Themed = { readonly light: string; readonly dark: string };",
    "",
    `export const color = ${obj(colors)} as const;`,
    "",
    ...SCALES.map((g) => `export const ${TS_GROUP[g]} = ${obj(scale(json, g))} as const;\n`),
    `export const fontFamily = ${JSON.stringify(json.type.families, null, 2)} as const;`,
    "",
    `export const typeStyle = {\n${typeStyles.map((s) => `  ${JSON.stringify(s.name)}: ${JSON.stringify({ family: s.family, fontSize: s.fontSize, lineHeight: s.lineHeight, fontWeight: s.fontWeight, letterSpacing: s.letterSpacing })},`).join("\n")}\n} as const;`,
    "",
    "export type ColorToken = keyof typeof color;",
    "export type SpaceToken = keyof typeof space;",
    "export type RadiusToken = keyof typeof radius;",
    "export type ShadowToken = keyof typeof shadow;",
    "export type TypeStyle = keyof typeof typeStyle;",
    "export type TokenName = ColorToken | SpaceToken | RadiusToken | ShadowToken | keyof typeof blur | keyof typeof duration | keyof typeof easing | keyof typeof opacity;",
    "",
    "/** The CSS custom property for a token, e.g. cssVar(\"ink\") is \"var(--ink)\". */",
    "export function cssVar(name: TokenName): string {",
    "  return `var(--${name})`;",
    "}",
    "",
  ].join("\n");

  return { css, ts };
}
