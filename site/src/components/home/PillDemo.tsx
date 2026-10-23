import { DictationPill, useReducedMotion } from "@walkietalkey/ui";

/** Step 3 of ForsideKomplet: the pill playing its four states. With reduced motion it rests in "Hold fn for at tale". */
export default function PillDemo() {
  const reduced = useReducedMotion();
  return reduced ? <DictationPill state="idle" /> : <DictationPill autoplay />;
}
