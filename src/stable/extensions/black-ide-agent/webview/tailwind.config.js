/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--vscode-sideBar-background, #1e1e1e)",
        panel: "var(--vscode-editor-background, #1e1e1e)",
        border: "var(--vscode-sideBar-border, var(--vscode-panel-border, var(--vscode-divider, #2d2d2d)))",
        foreground: "var(--vscode-sideBar-foreground, var(--vscode-editor-foreground, #cccccc))",
        muted: "var(--vscode-descriptionForeground, #888888)",
        
        buttonBg: "var(--vscode-button-background, #0e639c)",
        buttonFg: "var(--vscode-button-foreground, #ffffff)",
        buttonHoverBg: "var(--vscode-button-hoverBackground, #1177bb)",
        
        inputBg: "var(--vscode-input-background, #2d2d2d)",
        inputFg: "var(--vscode-input-foreground, #cccccc)",
        inputBorder: "var(--vscode-input-border, #3c3c3c)",
        inputPlaceholder: "var(--vscode-input-placeholderForeground, #888888)",
        
        focusBorder: "var(--vscode-focusBorder, #007fd4)",
        
        neonCyan: "var(--vscode-button-background, #00e5ff)",
        neonPurple: "var(--vscode-textLink-foreground, #bd93f9)",
        darkAccent: "var(--vscode-input-background, #2d2d2d)",

        // Settings page tokens
        successGreen: "#10b981",
        warningAmber: "#f59e0b",
        dangerRed: "#ef4444",
        settingsBg: "var(--vscode-editor-background, #1e1e1e)",
        settingsCard: "var(--vscode-input-background, #252526)",
        settingsCardHover: "var(--vscode-list-hoverBackground, #2a2d2e)",
      },
      animation: {
        'accordion-open': 'accordionOpen 0.25s ease-out forwards',
        'accordion-close': 'accordionClose 0.2s ease-in forwards',
        'slide-up': 'slideUp 0.18s ease-out forwards',
        'fade-in': 'fadeIn 0.18s ease-out forwards',
      },
      keyframes: {
        accordionOpen: {
          '0%': { maxHeight: '0px', opacity: '0' },
          '100%': { maxHeight: '600px', opacity: '1' },
        },
        accordionClose: {
          '0%': { maxHeight: '600px', opacity: '1' },
          '100%': { maxHeight: '0px', opacity: '0' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
