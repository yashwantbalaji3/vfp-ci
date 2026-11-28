/** The product name lives in exactly one place (provisional; no brand selected). */
export const BRAND = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? "Vegetarian Food Platform",
  tagline: "Find vegetarian food you want to eat, and see what is known about it.",
} as const;
