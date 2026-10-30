'use client';

import { useId } from 'react';

/** A lightweight, self-contained robot with a front, back and turning chassis. */
export function ZafarRobot({ compact = false }: { compact?: boolean }) {
  // Multiple robots can be rendered together without sharing SVG paint servers.
  const id = useId().replace(/:/g, '');
  const paint = (name: string) => `url(#${id}-${name})`;

  return (
    <span className={`zafar-robot${compact ? ' zafar-robot--compact' : ''}`} aria-hidden="true">
      <span className="zafar-robot__halo" />
      <span className="zafar-robot__orbit" />
      <span className="zafar-robot__shadow" />
      <span className="zafar-robot__float">
        <span className="zafar-robot__turner">
          <span className="zafar-robot__side zafar-robot__side--head zafar-robot__side--right" />
          <span className="zafar-robot__side zafar-robot__side--head zafar-robot__side--left" />
          <span className="zafar-robot__side zafar-robot__side--body zafar-robot__side--right" />
          <span className="zafar-robot__side zafar-robot__side--body zafar-robot__side--left" />
          <svg className="zafar-robot__face zafar-robot__front" viewBox="0 0 120 120" focusable="false">
            <defs>
              <linearGradient id={`${id}-shell`} x1="15" y1="13" x2="91" y2="96" gradientUnits="userSpaceOnUse">
                <stop stopColor="#f2fffa" /><stop offset=".42" stopColor="#b7eddf" /><stop offset="1" stopColor="#5ebdac" />
              </linearGradient>
              <linearGradient id={`${id}-body`} x1="39" y1="65" x2="82" y2="107" gradientUnits="userSpaceOnUse">
                <stop stopColor="#e0f9f0" /><stop offset="1" stopColor="#70cbbb" />
              </linearGradient>
              <linearGradient id={`${id}-screen`} x1="31" y1="30" x2="89" y2="66" gradientUnits="userSpaceOnUse">
                <stop stopColor="#174c54" /><stop offset="1" stopColor="#072e38" />
              </linearGradient>
              <clipPath id={`${id}-screen-clip`}><rect x="27" y="26" width="66" height="42" rx="15" /></clipPath>
              <linearGradient id={`${id}-visor-light`} x1="32" y1="29" x2="76" y2="58" gradientUnits="userSpaceOnUse">
                <stop stopColor="#fff" stopOpacity=".35" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
            </defs>

            <path d="M60 20V11" stroke="#286f6c" strokeWidth="3" strokeLinecap="round" />
            <circle className="zafar-robot__beacon" cx="60" cy="9" r="4.2" fill="#f9bd5d" />
            <circle cx="59" cy="8" r="1.4" fill="#fff2c6" />

            <g className="zafar-robot__arm zafar-robot__arm--left">
              <path d="M37 72C29 70 24 76 22 82" fill="none" stroke="#328c80" strokeWidth="7" strokeLinecap="round" />
              <circle cx="20" cy="84" r="7" fill={paint('body')} stroke="#27786f" strokeWidth="2" />
              <path d="M17 82.5h5" stroke="#eefcf7" strokeWidth="1.5" strokeLinecap="round" />
            </g>
            <g className="zafar-robot__arm zafar-robot__arm--right">
              <path d="M83 72c8-2 13 4 15 10" fill="none" stroke="#328c80" strokeWidth="7" strokeLinecap="round" />
              <circle cx="100" cy="84" r="7" fill={paint('body')} stroke="#27786f" strokeWidth="2" />
              <path d="M98 82.5h5" stroke="#eefcf7" strokeWidth="1.5" strokeLinecap="round" />
            </g>

            <rect x="42" y="96" width="15" height="9" rx="4.5" fill="#418f82" />
            <rect x="63" y="96" width="15" height="9" rx="4.5" fill="#418f82" />
            <rect x="34" y="66" width="52" height="37" rx="15" fill={paint('body')} stroke="#2a7e74" strokeWidth="2" />
            <path d="M42 72c4-3 11-4 18-4" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" />
            <rect x="46" y="78" width="28" height="16" rx="6" fill="#123f46" />
            <path className="zafar-robot__wave" d="M51 87h3l2-4 3 6 2-4 2 2h5" fill="none" stroke="#83f4d5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <circle className="zafar-robot__status" cx="70" cy="81.5" r="1.6" fill="#ffd281" />

            <rect x="20" y="21" width="80" height="59" rx="22" fill="#2a7f76" />
            <rect x="20" y="18" width="80" height="59" rx="22" fill={paint('shell')} stroke="#2a7770" strokeWidth="2" />
            <rect x="27" y="26" width="66" height="42" rx="15" fill={paint('screen')} stroke="#327f79" strokeWidth="1.3" />
            <path d="M40 27h40c7 0 12 5 12 12v2c-13-7-42-7-63 4v-6c0-7 5-12 11-12Z" fill={paint('visor-light')} />
            <g clipPath={paint('screen-clip')}><path className="zafar-robot__scan" d="M18 25h8l-13 44H5z" fill="#b8fff0" /></g>
            <g className="zafar-robot__eyes" fill="#a8ffe5">
              <rect x="42" y="41" width="8" height="11" rx="4" />
              <rect x="70" y="41" width="8" height="11" rx="4" />
            </g>
            <path d="M54 57c3.5 3 8.5 3 12 0" fill="none" stroke="#8ce8d2" strokeWidth="2.3" strokeLinecap="round" />
            <path d="M30 36c1-5 5-8 10-9" fill="none" stroke="#f6fffc" strokeOpacity=".65" strokeWidth="2" strokeLinecap="round" />
            <circle cx="25" cy="48" r="2" fill="#438f82" /><circle cx="95" cy="48" r="2" fill="#438f82" />
          </svg>

          <svg className="zafar-robot__face zafar-robot__back" viewBox="0 0 120 120" focusable="false">
            <defs>
              <linearGradient id={`${id}-back-shell`} x1="18" y1="20" x2="95" y2="84" gradientUnits="userSpaceOnUse">
                <stop stopColor="#dff8ef" /><stop offset=".55" stopColor="#99dbcb" /><stop offset="1" stopColor="#53ad9e" />
              </linearGradient>
              <linearGradient id={`${id}-back-core`} x1="36" y1="28" x2="79" y2="67" gradientUnits="userSpaceOnUse">
                <stop stopColor="#2f8b7e" /><stop offset="1" stopColor="#174d54" />
              </linearGradient>
            </defs>
            <path d="M60 20V11" stroke="#286f6c" strokeWidth="3" strokeLinecap="round" />
            <circle className="zafar-robot__beacon" cx="60" cy="9" r="4.2" fill="#f9bd5d" />
            <g className="zafar-robot__arm zafar-robot__arm--left">
              <path d="M37 72C29 70 24 76 22 82" fill="none" stroke="#328c80" strokeWidth="7" strokeLinecap="round" />
              <circle cx="20" cy="84" r="7" fill={paint('back-shell')} stroke="#27786f" strokeWidth="2" />
            </g>
            <g className="zafar-robot__arm zafar-robot__arm--right">
              <path d="M83 72c8-2 13 4 15 10" fill="none" stroke="#328c80" strokeWidth="7" strokeLinecap="round" />
              <circle cx="100" cy="84" r="7" fill={paint('back-shell')} stroke="#27786f" strokeWidth="2" />
            </g>
            <rect x="42" y="96" width="15" height="9" rx="4.5" fill="#418f82" />
            <rect x="63" y="96" width="15" height="9" rx="4.5" fill="#418f82" />
            <rect x="34" y="66" width="52" height="37" rx="15" fill={paint('back-shell')} stroke="#2a7e74" strokeWidth="2" />
            <rect x="46" y="77" width="28" height="17" rx="6" fill="#3d968a" />
            <path d="M51 82h18M51 86h18M51 90h12" stroke="#b9efe0" strokeWidth="1.5" strokeLinecap="round" />
            <rect x="20" y="21" width="80" height="59" rx="22" fill="#2a7f76" />
            <rect x="20" y="18" width="80" height="59" rx="22" fill={paint('back-shell')} stroke="#2a7770" strokeWidth="2" />
            <rect x="30" y="27" width="60" height="41" rx="14" fill={paint('back-core')} />
            <circle cx="60" cy="47.5" r="12" fill="#17444b" stroke="#68d7c0" strokeWidth="1.5" />
            <circle className="zafar-robot__status" cx="60" cy="47.5" r="5" fill="#91f4d9" />
            <path d="M37 39h7M37 43h5M76 52h7M78 56h5" stroke="#9fe7d4" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="36" cy="60" r="1.5" fill="#d3f8eb" /><circle cx="84" cy="35" r="1.5" fill="#d3f8eb" />
          </svg>
        </span>
      </span>
    </span>
  );
}
