import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Box, ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import { TerminalWindow } from "../components/TerminalWindow";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Dark theme for terminal
const darkTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#1e1e1e",
      paper: "#252526",
    },
  },
});

export const TerminalPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [isReady, setIsReady] = useState(false);

  const ptyFd = parseInt(searchParams.get("pty_fd") || "0", 10);
  const pid = parseInt(searchParams.get("pid") || "0", 10);
  const processName = searchParams.get("process_name") || "Unknown";
  const serverUrl = searchParams.get("server_url") || "";

  useEffect(() => {
    // Store server URL for API client to use
    if (serverUrl) {
      sessionStorage.setItem("terminal_server_url", serverUrl);
    }
    setIsReady(true);
  }, [serverUrl]);

  const handleClose = async () => {
    const window = getCurrentWebviewWindow();
    await window.close();
  };

  if (!isReady || !ptyFd || !pid) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <Box
          sx={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#888",
          }}
        >
          Loading terminal...
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Box
        sx={{
          height: "100vh",
          width: "100vw",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <TerminalWindow
          ptyFd={ptyFd}
          pid={pid}
          processName={processName}
          onClose={handleClose}
          serverUrl={serverUrl}
        />
      </Box>
    </ThemeProvider>
  );
};

export default TerminalPage;
