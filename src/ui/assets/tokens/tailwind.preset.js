/**
 * Aziro Design System — Tailwind preset
 * Usage:  module.exports = { presets: [require('./assets/tokens/tailwind.preset.js')] }
 * Source: WIP Aziro Corporate Presentation May 2026.pptx
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2B50A3',
          bright:  '#185DB8',
          50: '#EDF0FC', 100: '#BCC9F5', 200: '#A3C2E7',
          400: '#185DB8', 600: '#2B50A3', 800: '#223F80', 900: '#1A2F60',
        },
        accent: {
          DEFAULT: '#FE6701',
          50: '#FFF1E7', 100: '#FFD9BF', 500: '#FE6701', 600: '#EA7433', 700: '#C85408',
        },
        ink: '#323A3B',
        teal: '#3F9880',
        slate: '#435D74',
        danger: '#F02647',
        warning: '#FAB900',
        purple: '#834E9F',
        neutral: {
          50: '#F2F2F2', 100: '#E7E6E6', 200: '#D8D7D2', 300: '#C9C9C9',
          400: '#C1BFB9', 500: '#969696', 600: '#878787', 700: '#5A6566',
          800: '#323A3B', 900: '#222222',
        },
      },
      fontFamily: {
        brand: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
        sans:  ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        sm: ['0.875rem', { lineHeight: '1.5' }],
        base: ['1rem', { lineHeight: '1.6' }],
        xl: ['1.375rem', { lineHeight: '1.4' }],
        '2xl': ['1.75rem', { lineHeight: '1.25' }],
        '3xl': ['2.25rem', { lineHeight: '1.15' }],
        '4xl': ['3rem', { lineHeight: '1.1' }],
        '5xl': ['4rem', { lineHeight: '1.05' }],
        display: ['8rem', { lineHeight: '1' }],
      },
      spacing: {
        1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem', 5: '1.5rem',
        6: '2rem', 7: '3rem', 8: '4rem', 9: '6rem', 10: '8rem',
      },
      borderRadius: {
        sm: '6px', md: '10px', lg: '16px', xl: '24px', '2xl': '32px', full: '999px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(43,80,163,0.08)',
        md: '0 6px 20px rgba(43,80,163,0.10)',
        lg: '0 18px 48px rgba(43,80,163,0.16)',
        accent: '0 12px 32px rgba(254,103,1,0.28)',
      },
      backgroundImage: {
        'brand-gradient':  'linear-gradient(120deg, #2B50A3 0%, #185DB8 100%)',
        'accent-gradient': 'linear-gradient(120deg, #FE6701 0%, #EA7433 100%)',
        'duo-gradient':    'linear-gradient(120deg, #2B50A3 0%, #185DB8 55%, #FE6701 100%)',
      },
    },
  },
};
