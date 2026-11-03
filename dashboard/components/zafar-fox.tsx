/** Original zAfAr fox mascot, drawn as a small monochrome ink illustration. */
export function ZafarFox({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`zafar-fox${compact ? ' zafar-fox--compact' : ''}`} aria-hidden="true">
      <span className="zafar-fox__float">
        <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M23 51 17 17l30 17c8-3 18-3 26 0l30-17-7 36c8 9 12 19 10 31-3 21-21 31-46 31S18 103 15 82c-2-12 1-23 8-31Z" fill="#fff" stroke="#171714" strokeWidth="3.5" strokeLinejoin="round"/>
          <path d="m27 29 17 10-12 14-5-24Zm66 0L76 39l12 14 5-24Z" fill="#171714"/>
          <path d="M35 68c0-6 4-10 9-10s9 4 9 10" stroke="#171714" strokeWidth="3.5" strokeLinecap="round"/>
          <path d="M67 68c0-6 4-10 9-10s9 4 9 10" stroke="#171714" strokeWidth="3.5" strokeLinecap="round"/>
          <path d="M55 76c2-3 8-3 10 0l-5 5-5-5Z" fill="#171714"/>
          <path d="M60 81v5m0 0c-4 5-9 5-13 1m13-1c4 5 9 5 13 1" stroke="#171714" strokeWidth="2.5" strokeLinecap="round"/>
          <path d="M24 76c-6-2-11-1-15 2m17 4c-7 0-11 2-14 6m88-12c6-2 11-1 15 2m-17 4c7 0 11 2 14 6" stroke="#5f5c56" strokeWidth="2" strokeLinecap="round"/>
          <path d="M34 102c9-6 17-8 26-8s17 2 26 8" stroke="#171714" strokeWidth="3" strokeLinecap="round"/>
          <path d="M19 48c-5 8-8 18-7 29 1 8 5 14 10 18" stroke="#171714" strokeWidth="2" strokeLinecap="round"/>
          <path d="M102 49c4 7 7 17 6 26" stroke="#171714" strokeWidth="2" strokeLinecap="round"/>
          <path d="M43 21c7-4 13-6 19-6" stroke="#171714" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </span>
    </span>
  );
}

