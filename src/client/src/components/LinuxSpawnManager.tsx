import { useState, useCallback } from "react";
import {
  Typography,
  TextField,
  Box,
  Paper,
  Stack,
  CircularProgress,
  Button,
  useMediaQuery,
  FormControlLabel,
  Checkbox,
} from "@mui/material";
import {
  PlayArrow as SpawnIcon,
  Terminal as TerminalIcon,
} from "@mui/icons-material";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { getApiClient, ModuleInfo } from "../lib/api";
import { useGlobalDebugLogger } from "../hooks/useGlobalDebugLogger";
import { useAppState } from "../hooks/useAppState";

interface LinuxSpawnManagerProps {
  onModulesUpdate?: (modules: ModuleInfo[]) => void;
}

// Open terminal in a separate Tauri window
const openTerminalWindow = async (
  ptyFd: number,
  pid: number,
  processName: string,
  serverUrl: string
) => {
  const windowLabel = `terminal-${pid}`;
  const params = new URLSearchParams({
    pty_fd: String(ptyFd),
    pid: String(pid),
    process_name: processName,
    server_url: serverUrl,
  });

  const webview = new WebviewWindow(windowLabel, {
    url: `index.html#/terminal?${params.toString()}`,
    title: `Terminal: ${processName} (PID: ${pid})`,
    width: 800,
    height: 500,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    center: true,
  });

  // Handle window creation errors
  webview.once("tauri://error", (e) => {
    console.error("Failed to create terminal window:", e);
  });
};

export function LinuxSpawnManager({ onModulesUpdate }: LinuxSpawnManagerProps) {
  const { system, systemActions } = useAppState();
  const connected = system.serverConnected;
  const attachedProcess = system.attachedProcess;
  const { addLog } = useGlobalDebugLogger();

  const [executablePath, setExecutablePath] = useState("");
  const [args, setArgs] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usePty = true; // PTY is always enabled

  const isCompactHeight = useMediaQuery("(max-height: 800px)");

  const handleSpawn = useCallback(async () => {
    if (!executablePath.trim()) {
      setError("Please enter an executable path");
      return;
    }

    setSpawning(true);
    setError(null);

    try {
      const client = getApiClient();

      // Parse arguments
      const argList = args.trim() ? args.split(/\s+/) : [];
      const processName = executablePath.split("/").pop() || executablePath;

      // Use PTY spawn if enabled
      if (usePty) {
        const result = await client.spawnProcessWithPty(
          executablePath.trim(),
          argList
        );
        console.log("PTY Spawn API result:", JSON.stringify(result, null, 2));

        if (
          result.success &&
          result.data?.pid &&
          result.data?.pty_fd !== undefined
        ) {
          const { pid, pty_fd } = result.data;
          addLog(
            "INFO",
            "SPAWN",
            `Process spawned with PTY - PID: ${pid}, PTY FD: ${pty_fd}`
          );

          // Open terminal in a separate window
          const serverUrl = client.getBaseUrl();
          openTerminalWindow(pty_fd, pid, processName, serverUrl);

          // Update system state
          await systemActions.updateProcessState({
            pid: pid,
            processname: processName,
          });

          // Fetch modules
          try {
            const modulesResult = await client.enumerateModules();
            if (modulesResult.data?.modules) {
              systemActions.updateModules(modulesResult.data.modules);
              if (onModulesUpdate) {
                onModulesUpdate(modulesResult.data.modules);
              }
            }
          } catch (e) {
            console.error("Failed to fetch modules:", e);
          }

          // Sync signal configurations to server on attach (skip for iOS)
          // Default: catch=false, pass=false (suppress signals, like GDB)
          const targetOs = system.serverInfo?.target_os;
          if (targetOs !== "ios") {
            try {
              const defaultSignalConfigs = [
                { signal: 4, catch_signal: false, pass_signal: false }, // SIGILL
                { signal: 6, catch_signal: false, pass_signal: false }, // SIGABRT
                { signal: 7, catch_signal: false, pass_signal: false }, // SIGBUS
                { signal: 8, catch_signal: false, pass_signal: false }, // SIGFPE
                { signal: 11, catch_signal: false, pass_signal: false }, // SIGSEGV
              ];
              await client.setAllSignalConfigs(defaultSignalConfigs);
              addLog(
                "INFO",
                "SIGNALS",
                "Synced default signal configurations to server"
              );
            } catch (signalError) {
              console.error(
                "Failed to sync signal configurations:",
                signalError
              );
              addLog(
                "WARN",
                "SIGNALS",
                "Failed to sync signal configurations to server"
              );
            }
          }
        } else {
          const errorMsg =
            (result as any).message || "Failed to spawn process with PTY";
          setError(errorMsg);
          addLog("ERROR", "SPAWN", errorMsg);
        }
      } else {
        // Regular spawn without PTY
        const result = await client.spawnProcess(
          executablePath.trim(),
          argList
        );
        console.log("Spawn API result:", JSON.stringify(result, null, 2));

        if (result.success && result.data?.pid) {
          const pid = result.data.pid;
          addLog("INFO", "SPAWN", `Process spawned with PID: ${pid}`);

          await systemActions.updateProcessState({
            pid: pid,
            processname: processName,
          });

          try {
            const modulesResult = await client.enumerateModules();
            if (modulesResult.data?.modules) {
              systemActions.updateModules(modulesResult.data.modules);
              if (onModulesUpdate) {
                onModulesUpdate(modulesResult.data.modules);
              }
            }
          } catch (e) {
            console.error("Failed to fetch modules:", e);
          }

          // Sync signal configurations to server on attach (skip for iOS)
          // Default: catch=false, pass=false (suppress signals, like GDB)
          const targetOs = system.serverInfo?.target_os;
          if (targetOs !== "ios") {
            try {
              const defaultSignalConfigs = [
                { signal: 4, catch_signal: false, pass_signal: false }, // SIGILL
                { signal: 6, catch_signal: false, pass_signal: false }, // SIGABRT
                { signal: 7, catch_signal: false, pass_signal: false }, // SIGBUS
                { signal: 8, catch_signal: false, pass_signal: false }, // SIGFPE
                { signal: 11, catch_signal: false, pass_signal: false }, // SIGSEGV
              ];
              await client.setAllSignalConfigs(defaultSignalConfigs);
              addLog(
                "INFO",
                "SIGNALS",
                "Synced default signal configurations to server"
              );
            } catch (signalError) {
              console.error(
                "Failed to sync signal configurations:",
                signalError
              );
              addLog(
                "WARN",
                "SIGNALS",
                "Failed to sync signal configurations to server"
              );
            }
          }
        } else {
          const errorMsg = (result as any).message || "Failed to spawn process";
          setError(errorMsg);
          addLog("ERROR", "SPAWN", errorMsg);
        }
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      setError(errorMsg);
      addLog("ERROR", "SPAWN", `Spawn failed: ${errorMsg}`);
    } finally {
      setSpawning(false);
    }
  }, [executablePath, args, usePty, addLog, systemActions, onModulesUpdate]);

  if (!connected) {
    return (
      <Paper
        sx={{
          p: isCompactHeight ? 1.5 : 2,
          border: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.paper",
          borderTopLeftRadius: 0,
        }}
      >
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            fontSize: isCompactHeight ? "10px" : "11px",
            textAlign: "center",
          }}
        >
          Connect to a server to spawn processes
        </Typography>
      </Paper>
    );
  }

  if (attachedProcess) {
    return (
      <Paper
        sx={{
          p: isCompactHeight ? 1.5 : 2,
          border: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.paper",
          borderTopLeftRadius: 0,
        }}
      >
        <Stack spacing={isCompactHeight ? 0.5 : 1}>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
          >
            Already attached to process: {attachedProcess.processname} (PID:{" "}
            {attachedProcess.pid})
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
          >
            Detach from the current process to spawn a new one.
          </Typography>
        </Stack>
      </Paper>
    );
  }

  return (
    <>
      <Paper
        sx={{
          p: isCompactHeight ? 1.5 : 2,
          border: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.paper",
          borderTopLeftRadius: 0,
        }}
      >
        <Stack spacing={isCompactHeight ? 1.5 : 2}>
          <Box
            display="flex"
            justifyContent="space-between"
            alignItems="center"
          >
            <Typography
              variant="subtitle1"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                fontSize: isCompactHeight ? "11px" : "12px",
                fontWeight: 600,
                color: "primary.main",
              }}
            >
              <TerminalIcon
                sx={{ fontSize: isCompactHeight ? "14px" : "16px" }}
              />
              Spawn Manager
            </Typography>
          </Box>

          {/* Executable Path Input */}
          <Box>
            <Typography
              variant="body2"
              sx={{
                fontSize: isCompactHeight ? "9px" : "10px",
                fontWeight: 600,
                mb: isCompactHeight ? 0.5 : 1,
              }}
            >
              Executable Path
            </Typography>
            <TextField
              fullWidth
              size="small"
              placeholder="/path/to/executable"
              value={executablePath}
              onChange={(e) => setExecutablePath(e.target.value)}
              disabled={spawning}
              sx={{
                "& .MuiInputLabel-root": {
                  fontSize: isCompactHeight ? "10px" : "11px",
                },
                "& .MuiInputBase-input": {
                  fontSize: isCompactHeight ? "10px" : "11px",
                  fontFamily: "monospace",
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
                }),
              }}
            />
          </Box>

          {/* Arguments Input */}
          <Box>
            <Typography
              variant="body2"
              sx={{
                fontSize: isCompactHeight ? "9px" : "10px",
                fontWeight: 600,
                mb: isCompactHeight ? 0.5 : 1,
              }}
            >
              Arguments (space-separated)
            </Typography>
            <TextField
              fullWidth
              size="small"
              placeholder="arg1 arg2 arg3"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              disabled={spawning}
              sx={{
                "& .MuiInputLabel-root": {
                  fontSize: isCompactHeight ? "10px" : "11px",
                },
                "& .MuiInputBase-input": {
                  fontSize: isCompactHeight ? "10px" : "11px",
                  fontFamily: "monospace",
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
                }),
              }}
            />
          </Box>

          {/* PTY Option */}
          <FormControlLabel
            control={
              <Checkbox
                checked={true}
                disabled={true}
                size="small"
                sx={{
                  py: 0,
                  "& .MuiSvgIcon-root": {
                    fontSize: isCompactHeight ? 16 : 18,
                  },
                }}
              />
            }
            label={
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
              >
                Enable Terminal I/O (PTY)
              </Typography>
            }
            sx={{ ml: 0, mt: isCompactHeight ? -0.5 : 0 }}
          />

          {/* Error Message */}
          {error && (
            <Typography
              variant="body2"
              sx={{
                fontSize: isCompactHeight ? "9px" : "10px",
                color: "error.main",
              }}
            >
              {error}
            </Typography>
          )}

          {/* Spawn Button */}
          <Button
            variant="contained"
            startIcon={
              spawning ? (
                <CircularProgress
                  size={isCompactHeight ? 12 : 14}
                  sx={{ color: "inherit" }}
                />
              ) : (
                <SpawnIcon
                  sx={{ fontSize: isCompactHeight ? "14px" : "16px" }}
                />
              )
            }
            onClick={handleSpawn}
            disabled={spawning || !executablePath.trim()}
            sx={{
              textTransform: "none",
              fontSize: isCompactHeight ? "10px" : "11px",
              py: isCompactHeight ? 0.5 : 0.75,
              px: isCompactHeight ? 1.5 : 2,
              minWidth: "auto",
            }}
          >
            {spawning ? "Spawning..." : "Spawn Process"}
          </Button>

          {/* Info */}
          <Paper
            sx={{
              p: isCompactHeight ? 1 : 1.5,
              backgroundColor: "action.hover",
              borderRadius: 1,
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontSize: isCompactHeight ? "9px" : "10px",
                color: "text.secondary",
              }}
            >
              {usePty
                ? "Terminal I/O enabled: A terminal window will open for stdin/stdout interaction."
                : "The process will be spawned in a suspended state (stopped at the entry point)."}
            </Typography>
          </Paper>
        </Stack>
      </Paper>
    </>
  );
}
