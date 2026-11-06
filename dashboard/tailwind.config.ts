import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}', './lib/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Paper & ember — warm bone canvas, warm-white panels, ink type.
        canvas: '#F4F3EC',
        paper: '#FCFCF9',
        wash: '#ECEAE0',
        line: '#E0DECF',
        linestrong: '#C9C6B6',
        ink: '#1A1814',
        'ink-soft': '#33312A',
        muted: '#66634F',
        faint: '#A09C8C',
        accent: {
          50: '#FCEDE2',
          100: '#F8D7C2',
          200: '#EFB08C',
          600: '#D9480F',
          700: '#B93E0D',
          800: '#963408',
          900: '#772C0B',
        },
        ok: { 50: '#EDF5EE', 100: '#DCEBDF', 200: '#B8D6C3', 600: '#237345', 700: '#1C5C37', 800: '#17492D' },
        warn: { 50: '#FAF3E1', 100: '#F5E9C8', 200: '#E8D49B', 600: '#9A6A0A', 700: '#7D5409', 800: '#5F400C', 900: '#3F2A0B' },
        bad: { 50: '#FAEDEA', 100: '#F4D8D3', 200: '#E7B2A9', 600: '#B3382A', 700: '#952D23', 800: '#74241C' },
      },
      fontFamily: {
        sans: ["'Archivo Variable'", 'Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ["'Fraunces Variable'", 'Fraunces', 'Georgia', 'serif'],
        mono: ["'JetBrains Mono Variable'", "'JetBrains Mono'", 'ui-monospace', 'monospace'],
      },
      borderRadius: { lg: '12px', xl: '14px', '2xl': '16px' },
      boxShadow: {
        card: '0 1px 2px rgba(26,24,20,0.05), 0 12px 32px -16px rgba(26,24,20,0.22)',
        lift: '0 2px 4px rgba(26,24,20,0.06), 0 18px 44px -18px rgba(26,24,20,0.30)',
      },
    },
  },
  plugins: [],
};

export default config;
