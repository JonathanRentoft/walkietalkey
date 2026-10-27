/* Run 10: how each feature's demo looks: the design system's ShowcaseCard with the production card's scene, on a CSS
   surface, so the page can hold it still while another background is the one that moves (front.ts). The most
   beautiful version of each, compared across production and run 8's three previews (_kit/work/run10/demos.md):
     - the phone sits on Liquid in the dark theme, the same graphite and bronze as production's GradientMotion in Nat,
       whose frames run in JavaScript and cannot be held still; 4:3, so the whole phone stands in the card;
     - the others keep production's surfaces at 16:10, each in a row of its own.
   The devices row has no card at all (Devices.astro). */
import type { ShowcaseCardProps } from "@walkietalkey/ui";
import type { ShowcaseKey } from "../../lib/features";

export type DemoKey = Exclude<ShowcaseKey, "devices">;

export type Look = Pick<
  ShowcaseCardProps,
  "surface" | "palette" | "theme" | "placement" | "ratio"
>;

export const LOOK: Record<DemoKey, Look> = {
  fn: { surface: "liquid", palette: "morgengry", ratio: "16 / 10" },
  phone: {
    surface: "liquid",
    palette: "morgengry",
    theme: "dark",
    placement: "phone",
    ratio: "4 / 3",
  },
  corrections: { surface: "gradient", palette: "rav", ratio: "16 / 10" },
  words: { surface: "barfield", palette: "rav", ratio: "16 / 10" },
  notify: { surface: "strips", palette: "flint", ratio: "16 / 10" },
};
