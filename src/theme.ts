// Inline-style theme. The host can't inject CSS into the sandboxed iframe, so
// colors come from `useBlockContext().theme` and are applied via inline styles.

export interface Palette {
  bg: string;
  fg: string;
  card: string;
  border: string;
  inputBg: string;
  accent: string;
  accentFg: string;
  danger: string;
  dangerBg: string;
  success: string;
  muted: string;
  chipBg: string;
  chipActiveBg: string;
  overlay: string;
  stageBg: string;
}

export function palette(dark: boolean): Palette {
  return dark
    ? {
        bg: '#0f1012',
        fg: '#e9ecef',
        card: '#1a1b1e',
        border: '#2c2e33',
        inputBg: '#25262b',
        accent: '#4dabf7',
        accentFg: '#0b1622',
        danger: '#ff8787',
        dangerBg: '#2c1f1f',
        success: '#69db7c',
        muted: '#909296',
        chipBg: '#25262b',
        chipActiveBg: '#1971c2',
        overlay: 'rgba(0,0,0,0.55)',
        stageBg: '#000000',
      }
    : {
        bg: '#ffffff',
        fg: '#1a1b1e',
        card: '#f8f9fa',
        border: '#dee2e6',
        inputBg: '#ffffff',
        accent: '#1c7ed6',
        accentFg: '#ffffff',
        danger: '#e03131',
        dangerBg: '#fff5f5',
        success: '#2f9e44',
        muted: '#868e96',
        chipBg: '#f1f3f5',
        chipActiveBg: '#a5d8ff',
        overlay: 'rgba(0,0,0,0.6)',
        stageBg: '#0b0c0e',
      };
}
