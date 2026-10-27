/* @walkietalkey/ui: the WalkieTalkey design system as typed React components.
   Import the styles once per app: import "@walkietalkey/ui/styles.css". */
import { GEO } from "./lib/geo";
import { MESH, PALETTES, WAVES } from "./lib/palettes";

export {
  Logo,
  FloatingMark,
  type LogoProps,
  type FloatingMarkProps,
} from "./components/Logo";
export {
  LiquidBackground,
  GlassStrips,
  DottedGlow,
  GradientBars,
  GradientFrame,
  GradientRows,
  BarField,
  GradientBackground,
  GradientMotion,
  Grain,
  type LiquidBackgroundProps,
  type GlassStripsProps,
  type DottedGlowProps,
  type GradientBarsProps,
  type GradientFrameProps,
  type GradientRowsProps,
  type BarFieldProps,
  type GradientBackgroundProps,
  type GradientMotionProps,
} from "./components/surfaces";
export { ShinyButton, type ShinyButtonProps } from "./components/ShinyButton";
export {
  DictationPill,
  PILL_LABELS,
  type DictationPillProps,
  type DictationPillLabels,
  type DictationPillState,
} from "./components/DictationPill";
export {
  FluidMesh,
  LightWaves,
  FluidImage,
  type FluidMeshProps,
  type LightWavesProps,
  type FluidImageProps,
} from "./components/webgl";
export { PrismText, type PrismTextProps } from "./components/PrismText";
export {
  LogoLoader,
  LogoIntro,
  type LogoLoaderProps,
  type LogoIntroProps,
} from "./components/loaders";
export {
  PhoneFrame,
  LaptopFrame,
  PhoneApp,
  Keycap,
  Notice,
  RelayDemo,
  AppIcon,
  PHONE_LABELS,
  type PhoneFrameProps,
  type LaptopFrameProps,
  type PhoneAppProps,
  type PhoneAppLabels,
  type PhoneAppState,
  type KeycapProps,
  type NoticeProps,
  type RelayDemoProps,
} from "./components/devices";
export {
  Transcript,
  FlipWords,
  type TranscriptProps,
  type FlipWordsProps,
} from "./components/text";
export {
  ShowcaseCard,
  SceneFn,
  ScenePhone,
  SceneNotify,
  SceneCleanup,
  SceneVocab,
  SceneMixed,
  SceneDevices,
  SceneLocal,
  type ShowcaseCardProps,
  type ShowcaseScene,
  type SceneProps,
} from "./components/scenes";
export {
  SpeakToDesk,
  SPEAK_TO_DESK_LABELS,
  type SpeakToDeskProps,
  type SpeakToDeskLabels,
} from "./components/SpeakToDesk";
export { useReducedMotion } from "./lib/hooks";
export type { Palette } from "./lib/palettes";

/** The presets the design system bundle exposes next to the components. */
export const palettes = PALETTES;
export const meshPresets = MESH;
export const wavePresets = WAVES;
export const geometry = GEO;
