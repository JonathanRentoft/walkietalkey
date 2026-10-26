/* Run 8: how each production feature's demo looks on the final pages: the design system's ShowcaseCard with the
   production card's scene, on a CSS surface, so the page can hold it still while another background is the one that
   moves (final.ts). Production's own surfaces, with two changes the owner's rules ask for:
     - "Dansk og engelsk i samme sætning" sat on GradientRows, which the final pages never use: Liquid in Flint now;
       and its sentence lands whole, as the app pastes it on release (`release`), instead of word by word.
     - "Eller tal ind i telefonen" sat on GradientMotion, whose frames run in JavaScript: Liquid in the dark theme now,
       the same glowing graphite and bronze on night, in CSS. */
import type { ShowcaseCardProps } from "@walkietalkey/ui";
import type { ShowcaseKey } from "../../lib/features";

export type Look = Pick<
  ShowcaseCardProps,
  "surface" | "palette" | "theme" | "placement" | "ratio" | "release"
>;

export const LOOK: Record<ShowcaseKey, Look> = {
  fn: { surface: "liquid", palette: "morgengry", ratio: "16 / 10" },
  phone: {
    surface: "liquid",
    palette: "morgengry",
    theme: "dark",
    placement: "phone",
    ratio: "5 / 6",
  },
  corrections: { surface: "gradient", palette: "rav", ratio: "4 / 3" },
  mixed: {
    surface: "liquid",
    palette: "flint",
    ratio: "4 / 3",
    release: true,
  },
  notify: { surface: "strips", palette: "flint", ratio: "4 / 3" },
  devices: { surface: "gradient", palette: "morgengry", ratio: "16 / 10" },
  words: { surface: "barfield", palette: "rav", ratio: "16 / 10" },
};
