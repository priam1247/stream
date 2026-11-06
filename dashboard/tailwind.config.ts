import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}', './lib/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      // Exactly three colors; every other tone is an opacity tint of one of these.
      colors: {
        paper: '#FBFAF6',
        ink: '#1A1814',
        accent: '#D9480F',
      },
      fontFamily: {
        // One face for everything.
        sans: ["'Archivo Variable'", 'Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ["'Archivo Variable'", 'Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ["'Archivo Variable'", 'Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: { lg: '12px', xl: '14px', '2xl': '16px' },
      boxShadow: {
        card: '0 1px 2px rgba(26,24,20,0.05), 0 12px 32px -18px rgba(26,24,20,0.28)',
        lift: '0 2px 4px rgba(26,24,20,0.06), 0 18px 44px -18px rgba(26,24,20,0.35)',
      },
    },
  },
  plugins: [],
};

export default config;
