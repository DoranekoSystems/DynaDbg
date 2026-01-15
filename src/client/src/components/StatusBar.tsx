import React from "react";
import { Box, Typography, Avatar } from "@mui/material";
import { StatusBar } from "../utils/constants";
import { ProcessInfo, AppInfo } from "../lib/api";

interface StatusBarComponentProps {
  currentMode:
    | "home"
    | "debugger"
    | "server"
    | "scanner"
    | "information"
    | "network"
    | "logs"
    | "state"
    | "tools";
  debuggerConnected?: boolean;
  serverConnected: boolean;
  connectionHost?: string;
  connectionPort?: number;
  lastHealthCheck?: { latency: number; timestamp: string } | null;
  attachedProcess?: ProcessInfo;
  attachedAppInfo?: AppInfo;
  currentBreakAddress?: string | null;
  isInBreakState?: boolean;
}

export const StatusBarComponent: React.FC<StatusBarComponentProps> = ({
  currentMode,
  serverConnected,
  connectionHost,
  connectionPort,
  lastHealthCheck,
  attachedProcess,
  attachedAppInfo,
  currentBreakAddress,
  isInBreakState,
}) => {
  const getConnectionStatus = () => {
    if (currentMode === "home") {
      if (serverConnected && attachedProcess) {
        return `Connected to ${attachedProcess.processname}`;
      } else if (serverConnected) {
        return `Connected to ${connectionHost}:${connectionPort}`;
      } else {
        return "Ready to Connect";
      }
    } else {
      if (serverConnected && connectionHost && connectionPort) {
        return `Connected to ${connectionHost}:${connectionPort}`;
      }
      return "Server Disconnected";
    }
  };

  const getConnectionStatusColor = () => {
    if (serverConnected) {
      return "#4CAF50"; // Green for connected
    } else {
      return "#f44336"; // Red for disconnected
    }
  };

  const getLatencyInfo = () => {
    if (serverConnected && lastHealthCheck) {
      return `${lastHealthCheck.latency}ms`;
    }
    return null;
  };

  const getProcessInfo = () => {
    if (attachedProcess) {
      const processName =
        attachedAppInfo?.name || attachedProcess.processname || "Unknown";
      const pid = attachedProcess.pid;
      // Hide PID for WASM mode (pid === 0)
      const isWasmMode = pid === 0;
      return { processName, pid, isWasmMode };
    }
    return null;
  };

  const getModeDisplayName = () => {
    switch (currentMode) {
      case "debugger":
        return "Debugger";
      case "scanner":
        return "Memory Scanner";
      case "server":
        return "Server Management";
      case "home":
        return "Home";
      case "information":
        return "Information";
      case "network":
        return "Network";
      case "logs":
        return "Logs";
      default:
        return "Unknown";
    }
  };

  const processInfo = getProcessInfo();

  return (
    <StatusBar>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
        <Typography variant="body2" sx={{ fontSize: "11px" }}>
          Mode: {getModeDisplayName()}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            fontSize: "11px",
            color: getConnectionStatusColor(),
            fontWeight: serverConnected ? "bold" : "normal",
          }}
        >
          Status: {getConnectionStatus()}
        </Typography>
        {processInfo && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {attachedAppInfo?.icon && (
              <Avatar
                src={`data:image/png;base64,${attachedAppInfo.icon}`}
                sx={{ width: 16, height: 16 }}
              />
            )}
            <Typography
              variant="body2"
              sx={{ fontSize: "11px", color: "#FF9800" }}
            >
              {processInfo.isWasmMode
                ? `Process: ${processInfo.processName}`
                : `Process: ${processInfo.processName} (PID: ${processInfo.pid})`}
            </Typography>
          </Box>
        )}
        {isInBreakState && currentBreakAddress ? (
          <Typography
            variant="body2"
            sx={{
              fontSize: "11px",
              color: "#4CAF50",
              fontWeight: "bold",
              backgroundColor: "rgba(76, 175, 80, 0.1)",
              padding: "2px 6px",
              borderRadius: "4px",
              border: "1px solid rgba(76, 175, 80, 0.3)",
            }}
          >
            🔴 BREAK: {currentBreakAddress}
          </Typography>
        ) : getLatencyInfo() ? (
          <Typography
            variant="body2"
            sx={{ fontSize: "11px", color: "#4CAF50" }}
          >
            Latency: {getLatencyInfo()}
          </Typography>
        ) : null}
      </Box>
    </StatusBar>
  );
};
