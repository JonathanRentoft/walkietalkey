/* Generated from tokens/tokens.json by scripts/gen-tokens.ts. Do not edit by hand. */

export type Themed = { readonly light: string; readonly dark: string };

export const color = {
  "surface-100": {"light":"#faf8f4","dark":"#131211"},
  "surface-200": {"light":"#ffffff","dark":"#1c1b19"},
  "surface-300": {"light":"#f2eee7","dark":"#0c0b0a"},
  "line": {"light":"#e6e0d6","dark":"#2d2b28"},
  "line-control": {"light":"#8a8278","dark":"#77716a"},
  "ink": {"light":"#1b1a19","dark":"#f4f1ec"},
  "ink-muted": {"light":"#625d56","dark":"#a9a39a"},
  "on-ink": {"light":"#faf8f4","dark":"#131211"},
  "night": "#171615",
  "night-line": "#ffffff1f",
  "on-night": "#f4f1ec",
  "on-night-muted": "#a9a39a",
  "perle": "#ece9e4",
  "platin": "#cfd3d7",
  "sand": "#e4d7c4",
  "rav": "#dcbc9b",
  "mokka": "#b7a492",
  "on-tone": "#1b1a19",
  "on-tone-muted": "#3f3a35",
  "on-gradient": {"light":"#1b1a19","dark":"#f4f1ec"},
  "on-gradient-muted": {"light":"#3f3a35","dark":"#d4cec5"},
  "perle-dyb": "#afaaa3",
  "platin-dyb": "#888d92",
  "sand-dyb": "#b6a182",
  "rav-dyb": "#ab7a4f",
  "mokka-dyb": "#775d49",
  "midnat": "#0e1b2b",
  "skifer": "#2d4560",
  "fjord": "#56739a",
  "syren": "#a39bcd",
  "lavendel": "#bca4d2",
  "dis": "#e2daec",
  "skifer-dyb": "#1c2f44",
  "fjord-dyb": "#3d5982",
  "syren-dyb": "#7870b2",
  "lavendel-dyb": "#9a7dbb",
  "glass": {"light":"#ffffff8c","dark":"#ffffff0f"},
  "glass-line": {"light":"#ffffffcc","dark":"#ffffff1f"},
  "signal-rec": {"light":"#c2392f","dark":"#ff6a5c"},
  "focus": "{ink}",
} as const;

export const space = {
  "space-1": "4px",
  "space-2": "8px",
  "space-3": "12px",
  "space-4": "16px",
  "space-6": "24px",
  "space-8": "32px",
  "space-12": "48px",
  "space-16": "64px",
  "space-24": "96px",
} as const;

export const radius = {
  "radius-sm": "8px",
  "radius-md": "12px",
  "radius-lg": "20px",
  "radius-xl": "32px",
  "radius-pill": "999px",
} as const;

export const shadow = {
  "shadow-soft": {"light":"0 1px 2px #1b1a190d, 0 8px 24px -10px #1b1a1926","dark":"0 1px 2px #00000080, 0 8px 24px -10px #000000b3"},
  "shadow-float": {"light":"0 2px 6px #1b1a1912, 0 24px 48px -18px #1b1a1940","dark":"0 2px 6px #00000099, 0 24px 48px -18px #000000e6"},
  "shadow-glow": {"light":"0 12px 40px -12px #ab7a4f66, 0 12px 44px -16px #888d9266","dark":"0 12px 40px -12px #ab7a4f4d, 0 12px 44px -16px #888d924d"},
  "focus-ring": {"light":"0 0 0 2px #faf8f4, 0 0 0 4px #1b1a19","dark":"0 0 0 2px #131211, 0 0 0 4px #f4f1ec"},
} as const;

export const blur = {
  "blur-liquid": "72px",
  "blur-glass": "18px",
} as const;

export const duration = {
  "duration-fast": "140ms",
  "duration-base": "240ms",
  "duration-slow": "480ms",
  "duration-sheen": "2800ms",
  "duration-float": "6000ms",
  "duration-drift": "28000ms",
} as const;

export const easing = {
  "ease-flow": "cubic-bezier(0.22, 1, 0.36, 1)",
  "ease-glide": "cubic-bezier(0.65, 0, 0.35, 1)",
  "ease-pop": "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

export const opacity = {
  "grain-opacity": "0.14",
} as const;

export const fontFamily = {
  "sans": "\"Albert Sans\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  "mono": "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace"
} as const;

export const typeStyle = {
  "display-xl": {"family":"sans","fontSize":"72px","lineHeight":0.98,"fontWeight":600,"letterSpacing":"-0.035em"},
  "display": {"family":"sans","fontSize":"52px","lineHeight":1,"fontWeight":600,"letterSpacing":"-0.03em"},
  "title": {"family":"sans","fontSize":"34px","lineHeight":1.1,"fontWeight":600,"letterSpacing":"-0.02em"},
  "heading": {"family":"sans","fontSize":"22px","lineHeight":1.3,"fontWeight":600,"letterSpacing":"-0.01em"},
  "body-lg": {"family":"sans","fontSize":"18px","lineHeight":1.6,"fontWeight":400,"letterSpacing":"0"},
  "body": {"family":"sans","fontSize":"16px","lineHeight":1.6,"fontWeight":400,"letterSpacing":"0"},
  "label": {"family":"sans","fontSize":"14px","lineHeight":1.35,"fontWeight":500,"letterSpacing":"0"},
  "caption": {"family":"sans","fontSize":"12px","lineHeight":1.4,"fontWeight":500,"letterSpacing":"0.01em"},
  "code": {"family":"mono","fontSize":"13px","lineHeight":1.6,"fontWeight":400,"letterSpacing":"0"},
} as const;

export type ColorToken = keyof typeof color;
export type SpaceToken = keyof typeof space;
export type RadiusToken = keyof typeof radius;
export type ShadowToken = keyof typeof shadow;
export type TypeStyle = keyof typeof typeStyle;
export type TokenName = ColorToken | SpaceToken | RadiusToken | ShadowToken | keyof typeof blur | keyof typeof duration | keyof typeof easing | keyof typeof opacity;

/** The CSS custom property for a token, e.g. cssVar("ink") is "var(--ink)". */
export function cssVar(name: TokenName): string {
  return `var(--${name})`;
}
