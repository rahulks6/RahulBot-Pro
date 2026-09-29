import { colors } from "./colors";

export const typography = {
  displayLarge: { fontSize: 28, fontWeight: "700" as const, color: colors.textPrimary },
  title: { fontSize: 20, fontWeight: "700" as const, color: colors.textPrimary },
  body: { fontSize: 15, fontWeight: "400" as const, color: colors.textPrimary },
  bodyStrong: { fontSize: 15, fontWeight: "600" as const, color: colors.textPrimary },
  caption: { fontSize: 13, fontWeight: "400" as const, color: colors.textSecondary },
  label: { fontSize: 13, fontWeight: "600" as const, color: colors.textSecondary },
} as const;
