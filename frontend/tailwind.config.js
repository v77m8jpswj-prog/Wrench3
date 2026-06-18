/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
        "./src/**/*.{js,jsx,ts,tsx}",
        "./public/index.html"
    ],
    theme: {
        extend: {
            fontFamily: {
                head: ["'Barlow Condensed'", "Impact", "sans-serif"],
                mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
                body: ["'JetBrains Mono'", "ui-monospace", "monospace"],
            },
            colors: {
                bg: {
                    DEFAULT: "#0A0A0A",
                    1: "#0A0A0A",
                    2: "#121212",
                    3: "#171717",
                    4: "#262626",
                },
                rust: {
                    DEFAULT: "#FF5722",
                    50: "#FF7A4F",
                    600: "#E64A19",
                },
                amber2: {
                    DEFAULT: "#FFC107",
                    dim: "#A1730B",
                },
                danger: "#D32F2F",
                ok: "#2E7D32",
                ink: {
                    DEFAULT: "#FFFFFF",
                    2: "#A1A1AA",
                    3: "#52525B",
                },
                line: "#333333",
            },
            keyframes: {
                pulseRust: {
                    "0%,100%": { boxShadow: "0 0 0 0 rgba(255,87,34,0.6)" },
                    "50%":     { boxShadow: "0 0 0 24px rgba(255,87,34,0)" },
                },
                scan: {
                    "0%": { transform: "translateY(-100%)" },
                    "100%": { transform: "translateY(100vh)" },
                },
                blink: {
                    "0%,49%": { opacity: 1 },
                    "50%,100%": { opacity: 0 },
                },
                bar: {
                    "0%,100%": { transform: "scaleY(0.35)" },
                    "50%":    { transform: "scaleY(1)" },
                },
            },
            animation: {
                pulseRust: "pulseRust 1.4s ease-out infinite",
                scan: "scan 5s linear infinite",
                blink: "blink 1s steps(2) infinite",
                bar: "bar 0.5s ease-in-out infinite",
            },
        }
    },
    plugins: [require("tailwindcss-animate")],
};
