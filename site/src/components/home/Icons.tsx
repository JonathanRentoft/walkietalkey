/* The two little icons of ForsideKomplet, drawn as in its preview. */
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

export function FileIcon(p: { dir?: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={
          p.dir
            ? "M2 4.2h4.2l1.4 1.6H14v6.8H2Z"
            : "M4 1.8h5.2L12 4.6v9.6H4ZM9 1.8v3h3"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
}
