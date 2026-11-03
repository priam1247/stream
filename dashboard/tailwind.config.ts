import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}', './lib/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: { ink: '#171714', paper: '#ffffff', muted: '#5f5c56', line: '#e4e1da', wash: '#f6f5f2' },
      fontFamily: {
        sans: ["'Archivo Variable'", 'Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ["'JetBrains Mono Variable'", "'JetBrains Mono'", 'ui-monospace', 'monospace'],
      },
      borderRadius: { brand: '8px' },
      boxShadow: { none: 'none' },
    },
  },
  plugins: [],
};

export default config;
