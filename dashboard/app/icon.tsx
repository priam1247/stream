import { ImageResponse } from 'next/og';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1a1814' }}>
      <svg width="46" height="46" viewBox="0 0 100 100" fill="none" stroke="#fbfaf6" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 14 34 38M82 14 66 38" />
        <path d="M18 14 22 50Q24 72 50 86 76 72 78 50l4-36-20 20Q50 30 38 34Z" />
        <circle cx="38" cy="50" r="2.6" fill="#d9480f" stroke="none" />
        <circle cx="62" cy="50" r="2.6" fill="#d9480f" stroke="none" />
      </svg>
    </div>,
    { ...size },
  );
}
