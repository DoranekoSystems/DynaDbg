import { styled, alpha } from "@mui/material/styles";
import { Box, Button, IconButton, Typography } from "@mui/material";
import { darkTheme, borderColors, customBackgrounds } from "./theme";

// Original styled components from page-old.tsx
export const AppGrid = styled(Box, {
  shouldForwardProp: (prop) =>
    prop !== "sidebarWidth" &&
    prop !== "showRegisters" &&
    prop !== "registerWidth",
})<{ sidebarWidth?: number; showRegisters?: boolean; registerWidth?: number }>(
  ({ sidebarWidth = 240, showRegisters = false, registerWidth = 300 }) => {
    if (showRegisters && sidebarWidth > 0) {
      return {
        height: "100vh",
        display: "grid",
        gridTemplateRows: "40px auto 1fr 22px",
        gridTemplateColumns: `${sidebarWidth}px 1fr ${registerWidth}px`,
        gridTemplateAreas: `
        "header header header"
        "toolbar toolbar toolbar"
        "sidebar main registers"
        "status status status"
      `,
        "--sidebar-width": `${sidebarWidth}px`,
      };
    } else if (showRegisters) {
      return {
        height: "100vh",
        display: "grid",
        gridTemplateRows: "40px auto 1fr 22px",
        gridTemplateColumns: `1fr ${registerWidth}px`,
        gridTemplateAreas: `
        "header header"
        "toolbar toolbar"
        "main registers"
        "status status"
      `,
        "--sidebar-width": "0px",
        // Remove transitions to prevent redraw issues
        // transition: 'grid-template-columns 0.3s ease-in-out',
      };
    } else if (sidebarWidth > 0) {
      return {
        height: "100vh",
        display: "grid",
        gridTemplateRows: "40px auto 1fr 22px",
        gridTemplateColumns: `${sidebarWidth}px 1fr`,
        gridTemplateAreas: `
        "header header"
        "toolbar toolbar"
        "sidebar main"
        "status status"
      `,
        "--sidebar-width": `${sidebarWidth}px`,
      };
    } else {
      return {
        height: "100vh",
        display: "grid",
        gridTemplateRows: "40px auto 1fr 22px",
        gridTemplateColumns: "1fr",
        gridTemplateAreas: `
        "header"
        "toolbar"
        "main"
        "status"
      `,
        "--sidebar-width": "0px",
      };
    }
  }
);

export const Header = styled(Box)(() => ({
  gridArea: "header",
  backgroundColor: darkTheme.palette.background.paper,
  borderBottom: `1px solid ${borderColors.main}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  height: "100%",
  padding: "0 10px",
}));

export const ToolbarArea = styled(Box)(() => ({
  gridArea: "toolbar",
  backgroundColor: darkTheme.palette.background.paper,
  borderBottom: `1px solid ${borderColors.main}`,
}));

export const HeaderLeft = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
}));

export const HeaderRight = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
}));

export const Logo = styled(Typography)(() => ({
  fontWeight: "bold",
  fontSize: "18px",
  marginRight: "20px",
  color: darkTheme.palette.primary.main,
  letterSpacing: "-0.5px",
  display: "flex",
  alignItems: "center",
  lineHeight: 1,
  "& .MuiSvgIcon-root": {
    marginRight: "8px",
    fontSize: "22px",
    display: "flex",
    alignItems: "center",
  },
}));

export const ToolbarButton = styled(Button)(({ theme }) => ({
  backgroundColor: "transparent",
  color: theme.palette.text.primary,
  padding: "4px 8px",
  borderRadius: "4px",
  minWidth: "auto",
  "&:hover": {
    backgroundColor: customBackgrounds.hover,
  },
  "&.active": {
    backgroundColor: alpha(theme.palette.primary.main, 0.15),
    color: theme.palette.primary.main,
  },
}));

export const HeaderIconButton = styled(IconButton)(({ theme }) => ({
  color: theme.palette.text.primary,
  "&:hover": {
    backgroundColor: customBackgrounds.hover,
  },
}));

export const Sidebar = styled(Box)(() => ({
  gridArea: "sidebar",
  backgroundColor: darkTheme.palette.background.paper,
  borderRight: `1px solid ${borderColors.main}`,
  overflow: "auto",
  "&::-webkit-scrollbar": {
    width: "8px",
  },
  "&::-webkit-scrollbar-track": {
    background: darkTheme.palette.background.default,
  },
  "&::-webkit-scrollbar-thumb": {
    background: borderColors.main,
    borderRadius: "4px",
  },
  "&::-webkit-scrollbar-thumb:hover": {
    background: "#5a5a5e",
  },
}));

export const PanelHeader = styled(Box)(() => ({
  padding: "8px 10px",
  backgroundColor: customBackgrounds.light,
  borderBottom: `1px solid ${borderColors.main}`,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}));

export const MainContent = styled(Box)(() => ({
  gridArea: "main",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  backgroundColor: darkTheme.palette.background.default,
}));

export const TabContent = styled(Box)(() => ({
  flex: 1,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
}));

export const StatusBar = styled(Box)(() => ({
  gridArea: "status",
  backgroundColor: darkTheme.palette.background.paper,
  borderTop: `1px solid ${borderColors.main}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 10px",
  fontSize: "12px",
  color: darkTheme.palette.text.primary,
}));

export const RegisterViewContainer = styled(Box)(({ theme }) => ({
  gridArea: "registers",
  width: "300px",
  height: "100%",
  backgroundColor: theme.palette.background.paper,
  borderLeft: `1px solid ${borderColors.main}`,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  transition: "transform 0.2s ease-in-out",
}));

export const RegisterArea = styled(Box)(() => ({
  gridArea: "registers",
  backgroundColor: darkTheme.palette.background.paper,
  borderLeft: `1px solid ${borderColors.main}`,
  overflow: "auto",
  "&::-webkit-scrollbar": {
    width: "8px",
  },
  "&::-webkit-scrollbar-track": {
    background: darkTheme.palette.background.default,
  },
  "&::-webkit-scrollbar-thumb": {
    background: borderColors.main,
    borderRadius: "4px",
  },
  "&::-webkit-scrollbar-thumb:hover": {
    background: "#5a5a5e",
  },
}));

// Backwards compatibility aliases
export const HeaderBox = Header;
export const SidebarArea = Sidebar;
export const MainArea = MainContent;
export const StatusBarLeft = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "12px",
}));

export const StatusBarRight = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "12px",
}));

// Constants
export const SAMPLE_FUNCTIONS = [
  "initialize",
  "processInput",
  "calculateResult",
  "validateData",
  "handleError",
  "cleanup",
];

export const ENDIANNESS_OPTIONS = ["little", "big"];
export const CODEPAGE_OPTIONS = ["ASCII", "UTF-8", "UTF-16", "Shift-JIS"];

// Color constants
export const COLORS = {
  breakpoint: "#ff5252",
  currentLine: "#4caf50",
  modified: "#2196f3",
  highlighted: "#ff9800",
  jump: "#9c27b0",
  call: "#3f51b5",
} as const;

// Tab panel props interface
export interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}
