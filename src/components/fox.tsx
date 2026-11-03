/** Original zAfAr fox — monochrome line art. */
export function Fox({ size = 72, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 14 L34 38 M82 14 L66 38" />
      <path d="M18 14 L22 50 Q24 72 50 86 Q76 72 78 50 L82 14 L62 34 Q50 30 38 34 Z" />
      <path d="M28 54 Q40 62 50 70 Q60 62 72 54" />
      <circle cx="38" cy="50" r="2.6" fill="currentColor" />
      <circle cx="62" cy="50" r="2.6" fill="currentColor" />
      <path d="M46 72 L50 76 L54 72" />
    </svg>
  );
}

export function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="ink min-w-0 flex-1 bg-background px-4 py-3 text-sm leading-snug">{children}</div>
  );
}
