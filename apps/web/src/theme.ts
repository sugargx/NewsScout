import { webDarkTheme, webLightTheme, type Theme } from "@fluentui/react-components";

function clawpilotTheme(base: Theme): Theme {
  return {
    ...base,
    fontFamilyBase: '"Segoe UI", Aptos, Calibri, "Microsoft YaHei", "PingFang SC", sans-serif',
    borderRadiusMedium: "10px",
    borderRadiusLarge: "16px",
    colorNeutralBackground1: "var(--cp-surface)",
    colorNeutralBackground1Hover: "var(--cp-surface-soft)",
    colorNeutralBackground2: "var(--cp-surface-soft)",
    colorNeutralBackground3: "var(--cp-bg-elevated)",
    colorNeutralForeground1: "var(--cp-text)",
    colorNeutralForeground2: "var(--cp-text-muted)",
    colorNeutralForeground3: "var(--cp-text-soft)",
    colorNeutralStroke1: "var(--cp-border)",
    colorNeutralStroke2: "var(--cp-border-strong)",
    colorBrandBackground: "var(--cp-accent)",
    colorBrandBackgroundHover: "var(--cp-accent-hover)",
    colorBrandBackgroundPressed: "var(--cp-accent-hover)",
    colorBrandBackground2: "var(--cp-accent-soft)",
    colorBrandForeground1: "var(--cp-accent)",
    colorBrandForeground2: "var(--cp-accent)",
    colorBrandStroke1: "var(--cp-accent)",
    colorBrandStroke2: "var(--cp-accent)",
    colorCompoundBrandBackground: "var(--cp-accent)",
    colorCompoundBrandBackgroundHover: "var(--cp-accent-hover)",
    colorCompoundBrandForeground1: "var(--cp-accent)",
    colorCompoundBrandStroke: "var(--cp-accent)",
    colorNeutralForegroundOnBrand: "var(--cp-accent-fg)",
    colorBrandForegroundLink: "var(--cp-link)",
    colorPaletteRedForeground1: "var(--cp-danger)",
    colorPaletteGreenForeground1: "var(--cp-success)",
    colorPaletteYellowForeground1: "var(--cp-warning)",
  };
}

export const scoutNewsTheme = clawpilotTheme(document.documentElement.dataset.theme === "dark" ? webDarkTheme : webLightTheme);
