// Icons in the design system's style: 1.6 px strokes with round ends in
// currentColor (README, "Billeder og ikoner"). Lucide is the set the README
// names as close to it.
import {
  AudioLines,
  BookA,
  History,
  Info,
  Keyboard,
  RefreshCw,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Type,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SectionId } from "../lib/uiStore";

const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  history: History,
  general: SlidersHorizontal,
  key: Keyboard,
  text: Type,
  vocabulary: BookA,
  cleanup: Sparkles,
  phone: Smartphone,
  model: AudioLines,
  updates: RefreshCw,
  advanced: Wrench,
  about: Info,
};

export function SectionIcon(props: { id: SectionId; size?: number }) {
  const Icon = SECTION_ICONS[props.id];
  return (
    <Icon
      size={props.size ?? 18}
      strokeWidth={1.6}
      aria-hidden
      focusable={false}
      className="wt-icon"
    />
  );
}
