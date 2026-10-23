/* Palettes: which tone tokens a moving surface uses, in order.
   blobs: the liquid layer · stops: bars, dots and frames · metal: the logo gradient, with a highlight in the middle. */

/** The moving palettes: Morgengry (silver and champagne, default), Flint (cool silver), Rav (amber and mocha). Skumring (navy, blue, lavender) is an extra preset for dark sections only. */
export type Palette = "morgengry" | "flint" | "rav" | "skumring";

export interface PaletteDef {
  readonly blobs: readonly string[];
  readonly stops: readonly string[];
  readonly metal: readonly string[];
}

export const PALETTES: Record<Palette, PaletteDef> = {
  morgengry: {
    blobs: ["platin", "sand", "perle", "rav", "platin"],
    stops: ["perle", "platin", "sand", "rav"],
    metal: ["perle", "platin", "perle", "sand", "rav"],
  },
  flint: {
    blobs: ["platin", "perle", "platin", "perle", "platin"],
    stops: ["perle", "platin", "perle", "platin"],
    metal: ["perle", "platin", "perle", "platin", "platin-dyb"],
  },
  rav: {
    blobs: ["sand", "rav", "perle", "mokka", "rav"],
    stops: ["sand", "rav", "mokka"],
    metal: ["sand", "rav", "perle", "rav", "mokka"],
  },
  skumring: {
    blobs: ["fjord", "syren", "skifer", "lavendel", "fjord"],
    stops: ["fjord", "syren", "lavendel"],
    metal: ["dis", "lavendel", "dis", "syren", "fjord"],
  },
};

export function pal(name?: string): PaletteDef {
  return (
    (name && (PALETTES as Record<string, PaletteDef>)[name]) ||
    PALETTES.morgengry
  );
}

/* FluidMesh: void + four band stops, all theme-invariant tone tokens */
export const MESH: Record<string, readonly string[]> = {
  morgengry: ["perle", "platin", "perle", "sand", "rav"],
  flint: ["perle", "platin", "platin-dyb", "platin", "perle"],
  rav: ["sand", "perle", "rav", "mokka", "rav-dyb"],
  nat: ["night", "mokka-dyb", "platin-dyb", "perle-dyb", "sand"],
  skumring: ["midnat", "skifer", "fjord", "syren", "lavendel"],
};

/* LightWaves: the three light colours (top, middle, bottom) per palette; the ground is always night */
export const WAVES: Record<string, readonly string[]> = {
  morgengry: ["perle", "platin", "sand-dyb"],
  flint: ["perle", "platin", "platin-dyb"],
  rav: ["sand", "rav", "rav-dyb"],
  skumring: ["lavendel", "syren", "fjord", "midnat"],
};

/* GradientBackground */
export const GBG: Record<string, readonly [string, string, string, string]> = {
  morgengry: ["perle", "platin", "sand", "rav"],
  flint: ["perle", "platin", "platin-dyb", "perle"],
  rav: ["sand", "rav", "mokka", "rav-dyb"],
  nat: ["night", "mokka-dyb", "night", "sand-dyb"],
  skumring: ["midnat", "skifer", "fjord", "syren"],
};

/* GradientMotion */
export const GM: Record<string, readonly string[]> = {
  nat: ["rav-dyb", "platin-dyb", "sand-dyb", "mokka-dyb"],
  morgengry: ["platin-dyb", "sand-dyb", "perle-dyb", "rav-dyb"],
  rav: ["rav-dyb", "mokka-dyb", "sand-dyb", "rav"],
  flint: ["platin-dyb", "perle-dyb", "platin", "perle-dyb"],
  skumring: ["fjord", "syren-dyb", "lavendel-dyb", "skifer"],
};
