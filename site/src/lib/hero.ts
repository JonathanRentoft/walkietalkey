/* The current front page's hero copy (run 5's fn-led hero, the one in production). Run 6's concepts take their copy
   from lib/features.ts instead. Everything a visitor reads is Danish, approved by the owner in run 8. */

export interface HeroCopy {
  /** h1 */
  title: string;
  /** the sentence under the title; {fn} becomes a keycap */
  lead: string;
  /** a quieter second sentence */
  second: string;
  /** the line under the buttons, which starts with "Gratis og open source" */
  fine: string;
}

// Drafted in run 5 from the owner's brief and spec 2.6; approved in run 8.
export const HERO: HeroCopy = {
  title: "Tal. Slip. Indsæt.",
  lead: "Hold {fn} nede, og tal dansk. Når du slipper, står teksten der, hvor du skriver.",
  second: "Eller tal ind i telefonen, så lander teksten på din computer.",
  fine: "Gratis og open source · Mac og Windows · Ingen konto",
};
