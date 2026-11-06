import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/fraunces/full.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'zAfAr — WhatsApp Workspace', template: '%s · zAfAr' },
  description: 'Your zAfAr WhatsApp workspace: account access, connections, and support.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#f4f3ec',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="paper-grid min-h-screen overflow-x-hidden bg-canvas font-sans text-ink">
        {children}
      </body>
    </html>
  );
}
