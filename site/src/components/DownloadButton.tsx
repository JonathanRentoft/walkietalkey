import { ShinyButton, type ShinyButtonProps } from "@walkietalkey/ui";

/** A ShinyButton link with a download arrow instead of the forward arrow. Rendered on the server only (Hent). */
export default function DownloadButton(props: Omit<ShinyButtonProps, "icon">) {
  return (
    <ShinyButton
      {...props}
      icon={
        <svg
          className="wt-shiny-icon dl-icon"
          width={16}
          height={16}
          viewBox="0 0 16 16"
          aria-hidden
          focusable="false"
        >
          <path
            d="M8 2.5v9M4.25 7.75 8 11.5l3.75-3.75M3 13.75h10"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      }
    />
  );
}
