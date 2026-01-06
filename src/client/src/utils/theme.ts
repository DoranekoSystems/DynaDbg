import { createTheme } from "@mui/material/styles";

// Original dark theme from page-old.tsx
export const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#4fc1ff",
      light: "#7fd1ff",
      dark: "#3a92c2",
      contrastText: "#ffffff",
    },
    secondary: {
      main: "#89d185",
      light: "#a7dea4",
      dark: "#6bb067",
      contrastText: "#ffffff",
    },
    error: {
      main: "#f44747",
      light: "#f77070",
      dark: "#c53636",
    },
    warning: {
      main: "#dcdcaa",
      light: "#e5e5c3",
      dark: "#b8b887",
    },
    info: {
      main: "#c586c0",
      light: "#d4a0d0",
      dark: "#a66ca1",
    },
    success: {
      main: "#89d185",
      light: "#a7dea4",
      dark: "#6bb067",
    },
    text: {
      primary: "#d4d4d4",
      secondary: "#9b9b9b",
      disabled: "#6c6c6c",
    },
    background: {
      default: "#1e1e1e",
      paper: "#171717",
    },
    divider: "#3e3e42",
    action: {
      active: "#ffffff",
      hover: "rgba(255, 255, 255, 0.1)",
      selected: "rgba(255, 255, 255, 0.08)",
      disabled: "rgba(255, 255, 255, 0.3)",
      disabledBackground: "rgba(255, 255, 255, 0.12)",
      focus: "rgba(255, 255, 255, 0.12)",
    },
  },
  typography: {
    fontFamily: "'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif",
    fontSize: 12,
    button: {
      textTransform: "none",
      fontWeight: 400,
    },
  },
  shape: {
    borderRadius: 4,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          padding: 0,
          boxSizing: "border-box",
          height: "100vh",
          overflow: "hidden",
          lineHeight: "normal",
          fontSize: "12px",
          "& *": {
            boxSizing: "border-box",
          },
          "&::-webkit-scrollbar": {
            width: "10px",
            height: "10px",
          },
          "&::-webkit-scrollbar-track": {
            background: "#1e1e1e",
          },
          "&::-webkit-scrollbar-thumb": {
            background: "#3e3e42",
            borderRadius: "4px",
            "&:hover": {
              background: "#5a5a5e",
            },
          },
          "&::-webkit-scrollbar-corner": {
            background: "#1e1e1e",
          },
        },
        "*": {
          "&::-webkit-scrollbar": {
            width: "10px",
            height: "10px",
          },
          "&::-webkit-scrollbar-track": {
            background: "#1e1e1e",
            borderRadius: "4px",
          },
          "&::-webkit-scrollbar-thumb": {
            background: "#3e3e42",
            borderRadius: "4px",
            "&:hover": {
              background: "#5a5a5e",
            },
            "&:active": {
              background: "#6a6a6e",
            },
          },
          "&::-webkit-scrollbar-corner": {
            background: "#1e1e1e",
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontSize: "12px",
          padding: "4px 8px",
          minWidth: "auto",
        },
        containedPrimary: {
          backgroundColor: "#4fc1ff",
          "&:hover": {
            backgroundColor: "#3a92c2",
          },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontSize: "12px",
          minWidth: "auto",
          padding: "6px 12px",
          minHeight: "32px",
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: {
          minHeight: "32px",
          "& .MuiTabs-indicator": {
            backgroundColor: "#4fc1ff",
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          padding: "4px",
          fontSize: "16px",
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          fontSize: "11px",
          backgroundColor: "#171717",
          border: "1px solid #3e3e42",
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          fontSize: "12px",
          padding: "4px 8px",
          borderBottom: "1px solid #3e3e42",
        },
        head: {
          fontWeight: 600,
          backgroundColor: "#171717",
        },
      },
    },
  },
});

// Theme colors for styled components
export const borderColors = {
  main: "#3e3e42",
  light: "#5a5a5e",
};

export const customBackgrounds = {
  hover: "rgba(255, 255, 255, 0.1)",
  selected: "rgba(255, 255, 255, 0.08)",
  light: "rgba(255, 255, 255, 0.05)",
};
