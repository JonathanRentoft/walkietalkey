/* Line icons in the design system's style: 1.6 px strokes with round ends, in currentColor. */
import type { ReactNode } from "react";

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconMic = () => (
  <Icon>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Icon>
);
export const IconData = () => (
  <Icon>
    <ellipse cx="12" cy="6" rx="7" ry="2.6" />
    <path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" />
  </Icon>
);
export const IconTrain = () => (
  <Icon>
    <path d="M3.5 18.5h17" />
    <path d="M5 15l4-5 3.5 3 6.5-7.5" />
  </Icon>
);
export const IconEval = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </Icon>
);
export const IconVersions = () => (
  <Icon>
    <path d="M12 3.5l8 4.3-8 4.3-8-4.3 8-4.3z" />
    <path d="M4 12l8 4.3 8-4.3M4 16.2l8 4.3 8-4.3" />
  </Icon>
);
export const IconJournal = () => (
  <Icon>
    <path d="M6 3.5h10.5A1.5 1.5 0 0 1 18 5v15.5H7.5A1.5 1.5 0 0 1 6 19V3.5z" />
    <path d="M6 18.5A1.5 1.5 0 0 1 7.5 17H18M9.5 7.5h5M9.5 10.5h5" />
  </Icon>
);
export const IconPlay = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M8 5.5v13l10.5-6.5L8 5.5z" />
  </Icon>
);
export const IconStop = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </Icon>
);
export const IconPause = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M9 6.5v11M15 6.5v11" />
  </Icon>
);
export const IconCheck = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const IconRedo = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4.5v4h4" />
  </Icon>
);
export const IconWarn = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 4l9 16H3l9-16z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </Icon>
);
export const IconClock = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5l3 2" />
  </Icon>
);
export const IconCircle = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="6.5" />
  </Icon>
);
export const IconSkip = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M6 6.5l8 5.5-8 5.5v-11zM17.5 6.5v11" />
  </Icon>
);
export const IconArrowLeft = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);
export const IconQuestion = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8" />
    <path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 2-2.2 3.5M12 16.8v.01" />
  </Icon>
);
export const IconAwake = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
  </Icon>
);
