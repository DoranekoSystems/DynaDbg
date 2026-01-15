import React, { useState } from "react";
import { Tooltip, Chip, Box, CircularProgress } from "@mui/material";
import {
  BugReport,
  Computer,
  CheckCircle,
  Error,
  Android,
  Apple,
  DesktopWindows,
  Terminal,
  Memory,
  Search,
  Home,
  Info,
  NetworkCheck,
  Dashboard,
  PlayArrow as ResumeIcon,
  Pause as PauseIcon,
  Build as BuildIcon,
} from "@mui/icons-material";
import {
  Header as HeaderContainer,
  HeaderLeft,
  HeaderRight,
  Logo,
  ToolbarButton,
} from "../utils/constants";
import { ServerInfo, ProcessInfo, AppInfo, getApiClient } from "../lib/api";
import { Mode } from "../stores/uiStore";

interface HeaderProps {
  currentMode: Mode;
  debuggerConnected?: boolean;
  debuggerState?: string;
  serverConnected: boolean;
  serverInfo?: ServerInfo;
  attachedProcess?: ProcessInfo;
  attachedAppInfo?: AppInfo;
  spawnSuspended?: boolean;
  isInBreakState?: boolean;
  onModeChange?: (mode: Mode) => void;
  onLogoClick?: () => void;
  onResumeApp?: () => void;
  showLogsTab?: boolean;
  showNetworkTab?: boolean;
  showStateTab?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  currentMode,
  serverConnected,
  serverInfo,
  attachedProcess,
  spawnSuspended = false,
  isInBreakState = false,
  onModeChange,
  onLogoClick,
  onResumeApp,
  showLogsTab = false,
  showNetworkTab = false,
  showStateTab = false,
}) => {
  const [isResuming, setIsResuming] = useState(false);

  // Android process suspend/resume state
  const [isProcessSuspended, setIsProcessSuspended] = useState(false);
  const [isProcessStateChanging, setIsProcessStateChanging] = useState(false);

  // Handle resume button click
  const handleResume = async () => {
    if (!attachedProcess?.pid || !onResumeApp) return;

    setIsResuming(true);
    try {
      const client = getApiClient();
      const response = await client.resumeApp(attachedProcess.pid);

      if (response.success && response.data?.success) {
        // Call the callback to update state
        onResumeApp();
      } else {
        console.error(
          "Failed to resume app:",
          response.message || response.data
        );
      }
    } catch (error) {
      console.error("Failed to resume app:", error);
    } finally {
      setIsResuming(false);
    }
  };

  // Handle Android process suspend/resume toggle
  const handleProcessStateToggle = async () => {
    // Prevent multiple clicks while processing
    if (!attachedProcess?.pid || isInBreakState || isProcessStateChanging)
      return;

    setIsProcessStateChanging(true);
    try {
      const client = getApiClient();
      // doPlay: true = resume, false = suspend
      const response = await client.changeProcessState(isProcessSuspended);

      if (response.success) {
        setIsProcessSuspended(!isProcessSuspended);
      } else {
        console.error("Failed to change process state:", response.message);
      }
    } catch (error) {
      console.error("Failed to change process state:", error);
    } finally {
      // Add 1 second cooldown after state change
      setTimeout(() => {
        setIsProcessStateChanging(false);
      }, 400);
    }
  };

  // Determine OS icon based on server info
  const getOSIcon = () => {
    if (!serverInfo) return <BugReport />;

    const os = serverInfo.target_os.toLowerCase();
    if (os.includes("windows")) return <DesktopWindows />;
    if (os.includes("android")) return <Android />;
    if (os.includes("ios") || os.includes("darwin") || os.includes("macos"))
      return <Apple />;
    if (os.includes("linux")) return <Terminal />;
    return <BugReport />; // Default
  };

  return (
    <HeaderContainer>
      <HeaderLeft>
        <Logo
          onClick={onLogoClick}
          sx={{
            cursor: onLogoClick ? "pointer" : "default",
            "&:hover": onLogoClick
              ? {
                  opacity: 0.8,
                }
              : {},
            transition: "opacity 0.2s",
          }}
        >
          {getOSIcon()}
          DynaDbg
        </Logo>

        {/* Mode Selection */}
        <Tooltip title="Home" placement="bottom">
          <ToolbarButton
            onClick={() => onModeChange && onModeChange("home")}
            className={currentMode === "home" ? "active" : ""}
          >
            <Home fontSize="small" sx={{ mr: 0.5 }} />
            Home
          </ToolbarButton>
        </Tooltip>
        <Tooltip title="Server Management" placement="bottom">
          <ToolbarButton
            onClick={() => onModeChange && onModeChange("server")}
            className={currentMode === "server" ? "active" : ""}
            sx={{ ml: 0.5 }}
          >
            <Computer fontSize="small" sx={{ mr: 0.5 }} />
            Server
          </ToolbarButton>
        </Tooltip>
        {
          <Tooltip
            title={
              !attachedProcess
                ? serverConnected
                  ? "Attach to a process first"
                  : "Connect to server first"
                : "Debugger Mode"
            }
            placement="bottom"
          >
            <span>
              <ToolbarButton
                onClick={() => onModeChange && onModeChange("debugger")}
                className={currentMode === "debugger" ? "active" : ""}
                disabled={!serverConnected || !attachedProcess}
                sx={{
                  ml: 0.5,
                  ...((!serverConnected || !attachedProcess) && {
                    opacity: 0.5,
                    pointerEvents: "none",
                    color: "text.disabled",
                  }),
                }}
              >
                <BugReport fontSize="small" sx={{ mr: 0.5 }} />
                Debugger
              </ToolbarButton>
            </span>
          </Tooltip>
        }
        <Tooltip
          title={
            !attachedProcess
              ? serverConnected
                ? "Attach to a process first"
                : "Connect to server first"
              : "Memory Scanner"
          }
          placement="bottom"
        >
          <span>
            <ToolbarButton
              onClick={() => onModeChange && onModeChange("scanner")}
              className={currentMode === "scanner" ? "active" : ""}
              disabled={!serverConnected || !attachedProcess}
              sx={{
                ml: 0.5,
                ...((!serverConnected || !attachedProcess) && {
                  opacity: 0.5,
                  pointerEvents: "none",
                  color: "text.disabled",
                }),
              }}
            >
              <Search fontSize="small" sx={{ mr: 0.5 }} />
              Scanner
            </ToolbarButton>
          </span>
        </Tooltip>
        <Tooltip
          title={
            !attachedProcess
              ? serverConnected
                ? "Attach to a process first"
                : "Connect to server first"
              : "Information"
          }
          placement="bottom"
        >
          <span>
            <ToolbarButton
              onClick={() => onModeChange && onModeChange("information")}
              className={currentMode === "information" ? "active" : ""}
              disabled={!serverConnected || !attachedProcess}
              sx={{
                ml: 0.5,
                ...((!serverConnected || !attachedProcess) && {
                  opacity: 0.5,
                  pointerEvents: "none",
                  color: "text.disabled",
                }),
              }}
            >
              <Info fontSize="small" sx={{ mr: 0.5 }} />
              Information
            </ToolbarButton>
          </span>
        </Tooltip>
        <Tooltip
          title={
            !attachedProcess
              ? serverConnected
                ? "Attach to a process first"
                : "Connect to server first"
              : "Tools & Analyzers"
          }
          placement="bottom"
        >
          <span>
            <ToolbarButton
              onClick={() => onModeChange && onModeChange("tools")}
              className={currentMode === "tools" ? "active" : ""}
              disabled={!serverConnected || !attachedProcess}
              sx={{
                ml: 0.5,
                ...((!serverConnected || !attachedProcess) && {
                  opacity: 0.5,
                  pointerEvents: "none",
                  color: "text.disabled",
                }),
              }}
            >
              <BuildIcon fontSize="small" sx={{ mr: 0.5 }} />
              Tools
            </ToolbarButton>
          </span>
        </Tooltip>
        {showNetworkTab && (
          <Tooltip title="Network Requests" placement="bottom">
            <ToolbarButton
              onClick={() => onModeChange && onModeChange("network")}
              className={currentMode === "network" ? "active" : ""}
              sx={{ ml: 0.5 }}
            >
              <NetworkCheck fontSize="small" sx={{ mr: 0.5 }} />
              Network
            </ToolbarButton>
          </Tooltip>
        )}
        {showLogsTab && (
          <Tooltip title="Development Logs" placement="bottom">
            <ToolbarButton
              onClick={() => onModeChange && onModeChange("logs")}
              className={currentMode === "logs" ? "active" : ""}
              sx={{ ml: 0.5 }}
            >
              <Terminal fontSize="small" sx={{ mr: 0.5 }} />
              Logs
            </ToolbarButton>
          </Tooltip>
        )}
        {showStateTab && (
          <Tooltip title="Real-time State Monitor" placement="bottom">
            <ToolbarButton
              onClick={() => onModeChange && onModeChange("state")}
              className={currentMode === "state" ? "active" : ""}
              sx={{ ml: 0.5 }}
            >
              <Dashboard fontSize="small" sx={{ mr: 0.5 }} />
              State
            </ToolbarButton>
          </Tooltip>
        )}
      </HeaderLeft>

      <HeaderRight>
        {/* Resume Button - only show when spawn suspended */}
        {spawnSuspended && attachedProcess && (
          <Tooltip title="Resume suspended app" placement="bottom">
            <Chip
              size="small"
              icon={
                isResuming ? (
                  <CircularProgress size={12} color="inherit" />
                ) : (
                  <ResumeIcon sx={{ fontSize: "14px" }} />
                )
              }
              label={isResuming ? "Resuming..." : "Resume"}
              color="success"
              variant="outlined"
              onClick={handleResume}
              disabled={isResuming}
              sx={{
                fontSize: "10px",
                height: "22px",
                mr: 1,
                cursor: "pointer",
                "&:hover": {
                  backgroundColor: "rgba(76, 175, 80, 0.1)",
                },
              }}
            />
          </Tooltip>
        )}

        {/* Android Process Suspend/Resume Toggle - only show for Android when attached and not in break state */}
        {serverInfo?.target_os?.toLowerCase() === "android" &&
          attachedProcess &&
          !spawnSuspended && (
            <Tooltip
              title={
                isInBreakState
                  ? "Cannot change process state while in break state"
                  : isProcessSuspended
                    ? "Resume process"
                    : "Suspend process"
              }
              placement="bottom"
            >
              <span>
                <Chip
                  size="small"
                  icon={
                    isProcessStateChanging ? (
                      <CircularProgress size={12} color="inherit" />
                    ) : isProcessSuspended ? (
                      <ResumeIcon sx={{ fontSize: "14px" }} />
                    ) : (
                      <PauseIcon sx={{ fontSize: "14px" }} />
                    )
                  }
                  label={
                    isProcessStateChanging
                      ? "Changing..."
                      : isProcessSuspended
                        ? "Resume"
                        : "Suspend"
                  }
                  color={isProcessSuspended ? "success" : "warning"}
                  variant="outlined"
                  onClick={handleProcessStateToggle}
                  disabled={isProcessStateChanging || isInBreakState}
                  sx={{
                    fontSize: "10px",
                    height: "22px",
                    mr: 1,
                    cursor: isInBreakState ? "not-allowed" : "pointer",
                    opacity: isInBreakState ? 0.5 : 1,
                    "&:hover": {
                      backgroundColor: isInBreakState
                        ? "transparent"
                        : isProcessSuspended
                          ? "rgba(76, 175, 80, 0.1)"
                          : "rgba(255, 152, 0, 0.1)",
                    },
                  }}
                />
              </span>
            </Tooltip>
          )}

        {/* Server Info - always displayed when connected */}
        {serverConnected && serverInfo && (
          <Box sx={{ display: "flex", alignItems: "center", mr: 1 }}>
            <Chip
              size="small"
              icon={getOSIcon()}
              label={`${serverInfo.target_os} ${serverInfo.arch}`}
              color="info"
              variant="outlined"
              sx={{ fontSize: "10px", height: "22px", mr: 1 }}
            />
          </Box>
        )}

        {/* Process Info - displayed when attached (hide for WASM mode) */}
        {attachedProcess && attachedProcess.pid !== 0 && (
          <Box sx={{ display: "flex", alignItems: "center", mr: 1 }}>
            <Chip
              size="small"
              icon={<Memory />}
              label={`PID: ${attachedProcess.pid} - ${
                attachedProcess.processname || "Unknown"
              }`}
              color="warning"
              variant="outlined"
              sx={{ fontSize: "10px", height: "22px" }}
            />
          </Box>
        )}

        <Chip
          size="small"
          icon={serverConnected ? <CheckCircle /> : <Error />}
          label={serverConnected ? "Server Connected" : "Server Disconnected"}
          color={serverConnected ? "success" : "error"}
          variant="outlined"
          sx={{ fontSize: "11px", height: "24px" }}
        />
      </HeaderRight>
    </HeaderContainer>
  );
};
