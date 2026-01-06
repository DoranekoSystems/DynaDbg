import { useState, useEffect, useCallback } from "react";
import {
  Typography,
  Button,
  TextField,
  Box,
  Chip,
  Paper,
  Stack,
  CircularProgress,
  Alert,
  AlertTitle,
  useMediaQuery,
} from "@mui/material";
import {
  PlayArrow as ConnectIcon,
  Stop as DisconnectIcon,
  CheckCircle as ConnectedIcon,
  Cancel as DisconnectedIcon,
  Warning as WarningIcon,
} from "@mui/icons-material";

import { getApiClient, ServerInfo } from "../lib/api";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useAppState } from "../hooks/useAppState";

// Legacy props for backward compatibility (optional)
interface ServerConnectionProps {
  onConnectionChange?: (
    connected: boolean,
    info?: ServerInfo,
    host?: string,
    port?: number
  ) => void;
}

export function ServerConnection({
  onConnectionChange,
}: ServerConnectionProps) {
  // Use global app state instead of props
  const { system, systemActions } = useAppState();
  const serverConnected = system.serverConnected;
  const serverInfo = system.serverInfo;
  const connectionHost = system.connectionHost;
  const connectionPort = system.connectionPort;

  const isCompactHeight = useMediaQuery("(max-height: 800px)");
  // Save connection settings to localStorage
  const [savedHost, setSavedHost] = useLocalStorage("server-host", "localhost");
  const [savedPort, setSavedPort] = useLocalStorage("server-port", 8080);

  const [host, setHost] = useState(savedHost || connectionHost || "localhost");
  const [port, setPort] = useState(
    (savedPort || connectionPort || 8080).toString()
  );
  const [connecting, setConnecting] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>();
  const [authenticationStatus, setAuthenticationStatus] = useState<
    "none" | "authenticated" | "failed"
  >("none");
  const [connectionWarning, setConnectionWarning] = useState<
    string | undefined
  >();

  // Connection monitoring
  const handleConnectionStateChange = useCallback(
    (connected: boolean, error?: string) => {
      if (!connected && error) {
        console.warn("Connection state changed to disconnected:", error);
        setConnectionWarning(error);
        setAuthenticationStatus("none");

        // Update connection state
        systemActions.updateConnectionState(false, false);

        // Clear authentication info from Tauri state on disconnection
        systemActions.updateField("authToken", null);
        systemActions.updateField("serverSessionId", null);

        // Clear process and server info on disconnection (explicitly set to null)
        systemActions.updateField("attachedProcess", null);
        systemActions.updateField("attachedAppInfo", null);
        systemActions.updateField("serverInfo", null);
        systemActions.updateField("attachedModules", []);

        // Clear debug state on disconnection
        systemActions.updateField("isInBreakState", false);
        systemActions.updateField("currentThreadId", null);
        systemActions.updateField("currentBreakAddress", null);
        systemActions.updateField("currentRegisterData", {});

        // Clear breakpoints and watchpoints on disconnection
        systemActions.updateField("activeBreakpoints", []);
        systemActions.updateField("softwareBreakpoints", []);
        systemActions.updateField("watchpoints", []);

        console.log("All process and debug state cleared due to disconnection");

        // Notify parent component about disconnection (legacy support)
        onConnectionChange?.(false, undefined, undefined, undefined);
      }
    },
    [systemActions, onConnectionChange]
  );

  // Setup connection listener
  useEffect(() => {
    const client = getApiClient();
    client.addConnectionListener(handleConnectionStateChange);

    return () => {
      client.removeConnectionListener(handleConnectionStateChange);
    };
  }, [handleConnectionStateChange]);

  // Sync with global state and initialize from localStorage
  useEffect(() => {
    console.log("[ServerConnection] Syncing state:", {
      connectionHost,
      connectionPort,
      savedHost,
      savedPort,
    });

    // Sync UI state with global state (global store should be initialized)
    if (connectionHost) {
      console.log(
        "[ServerConnection] Using connectionHost from global state:",
        connectionHost
      );
      setHost(connectionHost);
    } else if (savedHost) {
      // Fallback to localStorage if global store is not yet initialized
      console.log(
        "[ServerConnection] Using savedHost from localStorage:",
        savedHost
      );
      setHost(savedHost);
    }

    if (connectionPort) {
      console.log(
        "[ServerConnection] Using connectionPort from global state:",
        connectionPort
      );
      setPort(connectionPort.toString());
    } else if (savedPort) {
      // Fallback to localStorage if global store is not yet initialized
      console.log(
        "[ServerConnection] Using savedPort from localStorage:",
        savedPort
      );
      setPort(savedPort.toString());
    }
  }, [connectionHost, connectionPort, savedHost, savedPort]);

  const handleConnect = async () => {
    setConnecting(true);
    setLastError(undefined);
    setConnectionWarning(undefined);
    setAuthenticationStatus("none");

    try {
      const client = getApiClient();
      client.updateConnection(host, parseInt(port));

      // Get server info directly (authentication is disabled on server)
      const serverInfo = await client.getServerInfo();

      // Save successful connection settings
      setSavedHost(host);
      setSavedPort(parseInt(port));

      // Update system state
      systemActions.updateConnectionState(true, true, host, parseInt(port));
      systemActions.updateProcessState(undefined, undefined, serverInfo);

      // Initialize debug state on new connection
      systemActions.updateField("isInBreakState", false);
      systemActions.updateField("currentThreadId", null);
      systemActions.updateField("currentBreakAddress", null);
      systemActions.updateField("currentRegisterData", {});
      systemActions.updateField("activeBreakpoints", []);
      systemActions.updateField("softwareBreakpoints", []);
      systemActions.updateField("watchpoints", []);
      systemActions.updateField("attachedProcess", null);
      systemActions.updateField("attachedAppInfo", null);
      systemActions.updateField("attachedModules", []);

      console.log("Debug state initialized on server connection");

      setAuthenticationStatus("authenticated");

      // Notify parent component (legacy support)
      onConnectionChange?.(true, serverInfo, host, parseInt(port));
    } catch (error) {
      console.error("Connection failed:", error);
      setLastError(
        error instanceof Error ? error.message : "Connection failed"
      );
      // Update system state
      systemActions.updateConnectionState(false, false);
      // Clear authentication info from Tauri state on connection failure
      systemActions.updateField("authToken", null);
      systemActions.updateField("serverSessionId", null);
      // Clear auth token in Rust backend
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_auth_token", { token: null });
      } catch (e) {
        console.warn("Failed to clear auth token in Rust backend:", e);
      }
      // Notify parent component (legacy support)
      onConnectionChange?.(false, undefined, undefined, undefined);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setConnectionWarning(undefined);
    setAuthenticationStatus("none");

    // Logout from server
    try {
      const client = getApiClient();
      await client.logout();
    } catch (error) {
      console.warn("Logout failed:", error);
    }

    // Clear auth token in Rust backend
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_auth_token", { token: null });
    } catch (e) {
      console.warn("Failed to clear auth token in Rust backend:", e);
    }

    // Update connection state
    systemActions.updateConnectionState(false, false);

    // Clear authentication info from Tauri state
    systemActions.updateField("authToken", null);
    systemActions.updateField("serverSessionId", null);

    // Clear process and server info (explicitly set to null)
    systemActions.updateField("attachedProcess", null);
    systemActions.updateField("attachedAppInfo", null);
    systemActions.updateField("serverInfo", null);
    systemActions.updateField("attachedModules", []);

    // Clear debug state
    systemActions.updateField("isInBreakState", false);
    systemActions.updateField("currentThreadId", null);
    systemActions.updateField("currentBreakAddress", null);
    systemActions.updateField("currentRegisterData", {});

    // Clear breakpoints and watchpoints
    systemActions.updateField("activeBreakpoints", []);
    systemActions.updateField("softwareBreakpoints", []);
    systemActions.updateField("watchpoints", []);

    console.log("All process and debug state cleared from Tauri state");

    // Notify parent component (legacy support)
    onConnectionChange?.(false, undefined, undefined, undefined);
  };

  return (
    <Paper
      sx={{
        p: isCompactHeight ? 1.5 : 2,
        border: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.paper",
        maxWidth: "50%",
      }}
    >
      <Stack spacing={isCompactHeight ? 1.5 : 2}>
        <Typography
          variant="subtitle1"
          sx={{
            fontSize: isCompactHeight ? "11px" : "12px",
            fontWeight: 600,
            color: "primary.main",
          }}
        >
          Server Connection
        </Typography>

        {/* Connection Form */}
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            label="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={serverConnected || connecting}
            size="small"
            sx={{
              minWidth: 120,
              "& .MuiInputLabel-root": {
                fontSize: isCompactHeight ? "10px" : "11px",
              },
              "& .MuiInputBase-input": {
                fontSize: isCompactHeight ? "10px" : "11px",
              },
              ...(isCompactHeight && {
                "& .MuiInputBase-root": {
                  minHeight: "20px",
                  fontSize: "11px",
                },
                "& .MuiInputBase-input": {
                  paddingTop: "4px",
                  paddingBottom: "4px",
                  fontSize: "11px",
                },
                "& .MuiInputLabel-root": {
                  fontSize: "11px",
                },
              }),
            }}
          />
          <TextField
            label="Port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={serverConnected || connecting}
            size="small"
            sx={{
              minWidth: 80,
              "& .MuiInputLabel-root": {
                fontSize: isCompactHeight ? "10px" : "11px",
              },
              "& .MuiInputBase-input": {
                fontSize: isCompactHeight ? "10px" : "11px",
              },
              ...(isCompactHeight && {
                "& .MuiInputBase-root": {
                  minHeight: "20px",
                  fontSize: "11px",
                },
                "& .MuiInputBase-input": {
                  paddingTop: "4px",
                  paddingBottom: "4px",
                  fontSize: "11px",
                },
                "& .MuiInputLabel-root": {
                  fontSize: "11px",
                },
              }),
            }}
          />
          {serverConnected ? (
            <Button
              variant="outlined"
              onClick={handleDisconnect}
              startIcon={<DisconnectIcon />}
              sx={{
                fontSize: isCompactHeight ? "10px" : "12px",
                py: isCompactHeight ? 0.25 : 0.5,
                px: 1,
                minWidth: "auto",
              }}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={handleConnect}
              disabled={connecting}
              startIcon={
                connecting ? <CircularProgress size={16} /> : <ConnectIcon />
              }
              sx={{
                fontSize: isCompactHeight ? "10px" : "12px",
                py: isCompactHeight ? 0.25 : 0.5,
                px: 1,
                minWidth: "auto",
              }}
            >
              Connect
            </Button>
          )}
        </Stack>

        {/* Connection Status */}
        <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
          {serverConnected ? (
            <Chip
              icon={<ConnectedIcon />}
              label={`Connected to ${connectionHost}:${connectionPort}`}
              color="success"
              size="small"
              sx={{
                fontSize: isCompactHeight ? "10px" : "11px",
                height: isCompactHeight ? "18px" : "20px",
              }}
            />
          ) : (
            <Chip
              icon={<DisconnectedIcon />}
              label="Disconnected"
              color="error"
              size="small"
              sx={{
                fontSize: isCompactHeight ? "10px" : "11px",
                height: isCompactHeight ? "18px" : "20px",
              }}
            />
          )}

          {/* Authentication status */}
          {authenticationStatus === "authenticated" && (
            <Chip
              label="Authenticated"
              color="success"
              size="small"
              sx={{
                fontSize: isCompactHeight ? "9px" : "10px",
                height: isCompactHeight ? "16px" : "18px",
              }}
            />
          )}
          {authenticationStatus === "failed" && (
            <Chip
              icon={<WarningIcon />}
              label="Auth Failed"
              color="error"
              size="small"
              sx={{
                fontSize: isCompactHeight ? "9px" : "10px",
                height: isCompactHeight ? "16px" : "18px",
              }}
            />
          )}
        </Box>

        {/* Connection Warning */}
        {connectionWarning && (
          <Alert
            severity="warning"
            sx={{
              fontSize: isCompactHeight ? "10px" : "11px",
              py: isCompactHeight ? 0.5 : 1,
            }}
          >
            <AlertTitle sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}>
              Connection Warning
            </AlertTitle>
            {connectionWarning}
          </Alert>
        )}

        {/* Server Info */}
        {serverConnected && serverInfo && (
          <Box
            sx={{
              mt: isCompactHeight ? 1 : 2,
              p: isCompactHeight ? 0.75 : 1,
              backgroundColor: "action.hover",
              borderRadius: 1,
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontSize: isCompactHeight ? "10px" : "11px",
                fontWeight: 600,
                mb: isCompactHeight ? 0.5 : 1,
              }}
            >
              Server Information
            </Typography>
            <Stack spacing={isCompactHeight ? 0.25 : 0.5}>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                Git Hash: {serverInfo.git_hash.substring(0, 8)}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                OS: {serverInfo.target_os}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                Arch: {serverInfo.arch}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                PID: {serverInfo.pid}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                Mode: {serverInfo.mode}
              </Typography>
              {serverInfo.build_timestamp && (
                <Typography
                  variant="body2"
                  sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
                >
                  Built:{" "}
                  {new Date(
                    serverInfo.build_timestamp * 1000
                  ).toLocaleDateString()}
                </Typography>
              )}
            </Stack>
          </Box>
        )}

        {/* Error Display */}
        {lastError && (
          <Alert
            severity="error"
            sx={{
              fontSize: isCompactHeight ? "10px" : "11px",
              py: isCompactHeight ? 0.5 : 1,
            }}
          >
            <AlertTitle sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}>
              Connection Error
            </AlertTitle>
            {lastError}
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}
