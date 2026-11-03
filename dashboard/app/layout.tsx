import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'zAfAr — WhatsApp Workspace', template: '%s · zAfAr' },
  description: 'Your zAfAr WhatsApp workspace: account access, connections, and support.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen overflow-x-hidden bg-white font-sans text-[#171714] selection:bg-black selection:text-white">
        <svg className="zafar-ink-filter" aria-hidden="true" focusable="false">
          <filter id="zafar-ink-wobble" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="7" />
            <feDisplacementMap in="SourceGraphic" scale="2" />
          </filter>
        </svg>
        {children}
      </body>
    </html>
  );
}
