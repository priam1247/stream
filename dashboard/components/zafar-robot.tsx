'use client';

/** A small inline illustration: no image downloads or external animation. */
export function ZafarRobot({ compact = false }: { compact?: boolean }) {
  return (
    <svg className={`zafar-robot${compact ? ' zafar-robot--compact' : ''}`} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse cx="58" cy="109" rx="39" ry="5" fill="#cbe9e2" />
      <path d="M58 19v-7" stroke="#237a71" strokeWidth="3" strokeLinecap="round" />
      <circle cx="58" cy="9" r="4" fill="#f3b95b" />
      <g className="zafar-robot__hand">
        <path d="M86 75 98 67" stroke="#2a8f83" strokeWidth="7" strokeLinecap="round" />
        <rect x="96" y="46" width="13" height="24" rx="6.5" fill="#91d6c5" stroke="#237a71" strokeWidth="2.5" transform="rotate(16 102 58)" />
        <path d="M96 43c3-6 8-9 13-8M103 29c5-1 9 0 12 3" fill="none" stroke="#e9a93d" strokeWidth="2" strokeLinecap="round" />
      </g>
      <path d="M27 75 18 82" stroke="#2a8f83" strokeWidth="7" strokeLinecap="round" />
      <circle cx="16" cy="84" r="6" fill="#91d6c5" stroke="#237a71" strokeWidth="2" />
      <rect x="32" y="69" width="51" height="37" rx="13" fill="#91d6c5" stroke="#237a71" strokeWidth="2.5" />
      <rect x="47" y="78" width="21" height="14" rx="5" fill="#f6fffb" />
      <circle cx="54" cy="85" r="2" fill="#e6ae4d" /><circle cx="61" cy="85" r="2" fill="#52bda9" />
      <rect x="19" y="22" width="78" height="55" rx="19" fill="#bcecdf" stroke="#237a71" strokeWidth="2.5" />
      <rect x="28" y="31" width="60" height="34" rx="13" fill="#f7fffc" />
      <circle cx="45" cy="47" r="4" fill="#1f6e67" /><circle cx="71" cy="47" r="4" fill="#1f6e67" />
      <path d="M52 55c4 4 8 4 12 0" fill="none" stroke="#287d73" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="35" cy="54" r="3" fill="#f8c7a9" opacity=".8" /><circle cx="81" cy="54" r="3" fill="#f8c7a9" opacity=".8" />
    </svg>
  );
}
