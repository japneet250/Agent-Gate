import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'Albert Sans', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // impeccable.style scale: title 18/600, body 13/400, meta 12/400.
        meta: ['0.75rem', { lineHeight: '1.1rem' }],
        body: ['0.8125rem', { lineHeight: '1.25rem' }],
        title: ['1.125rem', { lineHeight: '1.6rem', fontWeight: '600' }],
      },
      borderRadius: {
        // 8px fields, 3px pills, 12px cards.
        pill: '3px',
        field: '8px',
        card: '12px',
        panel: '16px',
      },
      colors: {
        ink: {
          950: '#07080b',
          900: '#0b0d12',
          850: '#10131a',
          800: '#151922',
          700: '#1d222d',
          // Panel chrome. The lightest step that keeps the `dim` token at
          // AA-large (3.09:1) — anything lighter and the supporting labels on
          // a verdict card stop being readable at a distance.
          750: '#252b38',
          600: '#2a3040',
          500: '#3b4356',
        },
        paper: '#f2f4f8',
        muted: '#9aa4b8',
        dim: '#6b7689',
        allow: { DEFAULT: '#3ddc97', dim: '#1b7d57', glow: 'rgba(61,220,151,0.16)' },
        block: { DEFAULT: '#ff4d64', dim: '#8f1f30', glow: 'rgba(255,77,100,0.18)' },
        escalate: { DEFAULT: '#ffb020', dim: '#8a5c0d', glow: 'rgba(255,176,32,0.16)' },
        accent: { DEFAULT: '#5b8cff', dim: '#2a4a99' },
      },
      boxShadow: {
        lift: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.8)',
        panel: '0 24px 64px -32px rgba(0,0,0,0.9)',
      },
      keyframes: {
        'slide-in': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.7', transform: 'scale(0.98)' },
          '100%': { opacity: '0', transform: 'scale(1.06)' },
        },
        drift: {
          '0%,100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '50%': { transform: 'translate3d(2%, -2%, 0) scale(1.06)' },
        },
      },
      animation: {
        'slide-in': 'slide-in 380ms cubic-bezier(0.16,1,0.3,1) both',
        'pulse-ring': 'pulse-ring 900ms ease-out forwards',
        drift: 'drift 26s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
