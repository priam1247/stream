/** Original zAfAr fox mascot, drawn as a monochrome, hand-inked inline SVG. */
import type { ReactNode } from 'react';

export function ZafarFox({ compact = false, full = false }: { compact?: boolean; full?: boolean }) {
  return (
    <span className={`zafar-fox${compact ? ' zafar-fox--compact' : ''}${full ? ' zafar-fox--full' : ''}`} aria-hidden="true">
      <span className="zafar-fox__float">
        <svg
          viewBox="0 0 100 100"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M18 14 34 38M82 14 66 38" />
          <path d="M18 14 22 50Q24 72 50 86 76 72 78 50l4-36-20 20Q50 30 38 34Z" />
          <path d="M28 54Q40 62 50 70 60 62 72 54" />
          <circle cx="38" cy="50" r="2.6" />
          <circle cx="62" cy="50" r="2.6" />
          <path d="m46 72 4 4 4-4" />
        </svg>
      </span>
    </span>
  );
}

export function ZafarBubble({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={` min-w-0 px-4 py-3 text-sm leading-snug ${className}`}>
      {children}
    </div>
  );
}
