/* The check of ForsideKomplet, drawn as in its preview (the plans' lists on the front page and Privatliv). */
export function Check(p: { s?: number }) {
  const s = p.s || 18;
  return (
    <svg width={s} height={s} viewBox="0 0 18 18" aria-hidden="true">
      <circle
        cx={9}
        cy={9}
        r={8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path
        d="M5.6 9.3 7.9 11.5 12.4 6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
