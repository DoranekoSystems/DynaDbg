import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Tooltip,
  Chip,
} from "@mui/material";
import {
  Close as CloseIcon,
  Refresh as RefreshIcon,
} from "@mui/icons-material";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getApiClient, ApiClient } from "../lib/api";

interface TerminalWindowProps {
  ptyFd: number;
  pid: number;
  processName: string;
  onClose: () => void;
  serverUrl?: string; // Optional: for standalone window mode
}

export const TerminalWindow: React.FC<TerminalWindowProps> = ({
  ptyFd,
  pid,
  processName,
  onClose,
  serverUrl,
}) => {
  const [isConnected, setIsConnected] = useState(true);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pollingRef = useRef<number | null>(null);
  const apiClientRef = useRef<ApiClient | null>(null);

  // Get or create API client
  const getClient = useCallback(() => {
    if (apiClientRef.current) {
      return apiClientRef.current;
    }

    // Check if we have a server URL from props or sessionStorage (for standalone window)
    const url = serverUrl || sessionStorage.getItem("terminal_server_url");
    if (url) {
      apiClientRef.current = new ApiClient(url);
      return apiClientRef.current;
    }

    // Fall back to global client
    return getApiClient();
  }, [serverUrl]);

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Consolas", "Monaco", "Courier New", monospace',
      cols: 360,
      rows: 150,
      scrollback: 10000,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        cursorAccent: "#1e1e1e",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#6a9955",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#6a9955",
        brightYellow: "#dcdcaa",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);

    // Function to fit terminal and notify PTY
    const doFit = () => {
      if (fitAddon && terminalRef.current) {
        try {
          fitAddon.fit();
          const { cols, rows } = term;
          console.log(`Terminal size: ${cols}x${rows}`);
          const client = getClient();
          // API expects (ptyFd, rows, cols)
          client.ptyResize?.(ptyFd, rows, cols).catch(console.error);
        } catch (e) {
          console.error("Fit error:", e);
        }
      }
    };

    // Delay fit to ensure container is properly sized
    setTimeout(doFit, 50);
    setTimeout(doFit, 200);
    setTimeout(doFit, 500);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Use ResizeObserver to detect container size changes
    const resizeObserver = new ResizeObserver(() => {
      doFit();
    });
    resizeObserver.observe(terminalRef.current);

    // Handle user input - send to PTY
    term.onData(async (data) => {
      if (!isConnected) return;
      try {
        const client = getClient();
        await client.ptyWrite(ptyFd, data);
      } catch (error) {
        console.error("Error writing to PTY:", error);
      }
    });

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        // Notify PTY of size change
        if (xtermRef.current) {
          const { cols, rows } = xtermRef.current;
          const client = getClient();
          // API expects (ptyFd, rows, cols)
          client.ptyResize?.(ptyFd, rows, cols).catch(console.error);
        }
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ptyFd, getClient, isConnected]);

  // Poll for PTY output
  const pollOutput = useCallback(async () => {
    if (!isConnected || !xtermRef.current) return;

    try {
      const client = getClient();
      const response = await client.ptyRead(ptyFd);

      if (response.success && response.data) {
        const { data, bytes } = response.data;
        if (bytes > 0 && data) {
          // Decode base64 data and write to xterm
          try {
            const decoded = atob(data);
            xtermRef.current.write(decoded);
          } catch {
            // If not base64, use as-is
            xtermRef.current.write(data);
          }
        }
      }
    } catch (error) {
      console.error("Error reading PTY:", error);
      setIsConnected(false);
    }
  }, [ptyFd, isConnected, getClient]);

  // Start polling when component mounts
  useEffect(() => {
    const poll = () => {
      pollOutput();
      pollingRef.current = window.setTimeout(poll, 50); // Poll every 50ms for smoother updates
    };
    poll();

    return () => {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
      }
    };
  }, [pollOutput]);

  // Handle close
  const handleClose = async () => {
    try {
      const client = getClient();
      await client.ptyClose(ptyFd);
    } catch (error) {
      console.error("Error closing PTY:", error);
    }
    onClose();
  };

  // Clear terminal
  const handleClear = () => {
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
  };

  return (
    <Paper
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "#1e1e1e",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 1.5,
          py: 0.5,
          backgroundColor: "#2d2d30",
          borderBottom: "1px solid #3e3e42",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 500, color: "#cccccc" }}
          >
            Terminal - {processName}
          </Typography>
          <Chip
            label={`PID: ${pid}`}
            size="small"
            sx={{
              height: 18,
              fontSize: "10px",
              backgroundColor: "#3c3c3c",
              color: "#cccccc",
            }}
          />
          <Chip
            label={`PTY: ${ptyFd}`}
            size="small"
            sx={{
              height: 18,
              fontSize: "10px",
              backgroundColor: "#3c3c3c",
              color: "#cccccc",
            }}
          />
          {!isConnected && (
            <Chip
              label="Disconnected"
              size="small"
              color="error"
              sx={{ height: 18, fontSize: "10px" }}
            />
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Tooltip title="Clear terminal">
            <IconButton size="small" onClick={handleClear}>
              <RefreshIcon sx={{ fontSize: 16, color: "#cccccc" }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Close terminal">
            <IconButton size="small" onClick={handleClose}>
              <CloseIcon sx={{ fontSize: 16, color: "#cccccc" }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* xterm.js terminal area */}
      <Box
        ref={terminalRef}
        sx={{
          flex: 1,
          width: "100%",
          minWidth: 0, // Important: allow flex item to shrink below content size
          height: "100%",
          overflow: "hidden",
          backgroundColor: "#1e1e1e",
          "& .xterm": {
            width: "100% !important",
            height: "100% !important",
            padding: 0,
          },
          "& .xterm-screen": {
            width: "100% !important",
          },
          "& .xterm-viewport": {
            width: "100% !important",
            overflowY: "auto !important",
            "&::-webkit-scrollbar": {
              width: "8px",
            },
            "&::-webkit-scrollbar-track": {
              background: "#1e1e1e",
            },
            "&::-webkit-scrollbar-thumb": {
              background: "#3e3e42",
              borderRadius: "4px",
            },
          },
        }}
      />

      {/* Status bar */}
      <Box
        sx={{
          px: 1,
          py: 0.25,
          backgroundColor: "#007acc",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <Typography
          variant="caption"
          sx={{ color: "#ffffff", fontSize: "10px" }}
        >
          {isConnected ? "Connected" : "Disconnected"}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "#ffffff", fontSize: "10px" }}
        >
          ncurses compatible
        </Typography>
      </Box>
    </Paper>
  );
};

export default TerminalWindow;
