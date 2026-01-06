import { useState, useEffect, useCallback } from "react";
import {
  Typography,
  TextField,
  Box,
  IconButton,
  Tooltip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  CircularProgress,
  useMediaQuery,
  Autocomplete,
} from "@mui/material";
import {
  Refresh as RefreshIcon,
  PlayArrow as SpawnIcon,
  Apps as AppsIcon,
  ArrowUpward as ArrowUpIcon,
  ArrowDownward as ArrowDownIcon,
} from "@mui/icons-material";

import {
  getApiClient,
  InstalledAppInfo,
  AppInfo,
  ModuleInfo,
} from "../lib/api";
import { useGlobalDebugLogger } from "../hooks/useGlobalDebugLogger";
import { useAppState } from "../hooks/useAppState";

// LocalStorage key for filter history
const SPAWN_FILTER_HISTORY_KEY = "spawn_manager_filter_history";
const MAX_HISTORY_ITEMS = 5;

interface SpawnManagerProps {
  onModulesUpdate?: (modules: ModuleInfo[]) => void;
}

export function SpawnManager({ onModulesUpdate }: SpawnManagerProps) {
  const { system, systemActions } = useAppState();
  const connected = system.serverConnected;
  const attachedProcess = system.attachedProcess;

  const isCompactHeight = useMediaQuery("(max-height: 800px)");
  const [apps, setApps] = useState<InstalledAppInfo[]>([]);
  const [filteredApps, setFilteredApps] = useState<InstalledAppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [spawningBundleId, setSpawningBundleId] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [filterHistory, setFilterHistory] = useState<string[]>([]);

  // Load filter history from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SPAWN_FILTER_HISTORY_KEY);
      if (saved) {
        setFilterHistory(JSON.parse(saved));
      }
    } catch (e) {
      console.error("Failed to load filter history:", e);
    }
  }, []);

  // Save history to localStorage
  const saveFilterHistory = useCallback((history: string[]) => {
    try {
      localStorage.setItem(SPAWN_FILTER_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.error("Failed to save filter history:", e);
    }
  }, []);

  // Add filter to history
  const addToFilterHistory = useCallback(
    (filter: string) => {
      if (!filter.trim()) return;
      setFilterHistory((prev) => {
        const filtered = prev.filter(
          (f) => f.toLowerCase() !== filter.toLowerCase()
        );
        const newHistory = [filter, ...filtered].slice(0, MAX_HISTORY_ITEMS);
        saveFilterHistory(newHistory);
        return newHistory;
      });
    },
    [saveFilterHistory]
  );

  const [appIcons, setAppIcons] = useState<Map<string, string>>(new Map());
  const [appRunningStatus, setAppRunningStatus] = useState<Map<string, number>>(
    new Map()
  );

  const { addLog, logInfo } = useGlobalDebugLogger();

  const loadApps = useCallback(async () => {
    if (!connected) return;

    setLoading(true);
    try {
      const client = getApiClient();
      const response = await client.getInstalledApps();

      if (response.success && response.data?.apps) {
        setApps(response.data.apps);
        // Load icons and running status for apps
        loadAppIcons(response.data.apps);
        loadAppRunningStatus(response.data.apps);
      } else {
        console.error("Failed to load apps:", response.message);
        setApps([]);
      }
    } catch (error) {
      console.error("Failed to load installed apps:", error);
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, [connected]);

  const loadAppIcons = async (appList: InstalledAppInfo[]) => {
    const client = getApiClient();
    const newIcons = new Map<string, string>();

    // Load icons for first 20 apps to avoid overwhelming the backend
    const appsToLoad = appList.slice(0, 20);

    await Promise.allSettled(
      appsToLoad.map(async (app) => {
        try {
          const iconUrl = await client.getAppIcon(app.bundleIdentifier);
          if (iconUrl) {
            newIcons.set(app.bundleIdentifier, iconUrl);
          }
        } catch (error) {
          console.debug(
            `Failed to load icon for app ${app.bundleIdentifier}:`,
            error
          );
        }
      })
    );

    setAppIcons((prev) => new Map([...prev, ...newIcons]));
  };

  const loadAppRunningStatus = async (appList: InstalledAppInfo[]) => {
    const client = getApiClient();
    const statusMap = new Map<string, number>();

    await Promise.allSettled(
      appList.map(async (app) => {
        try {
          const response = await client.getAppRunningStatus(
            app.bundleIdentifier
          );
          if (response.success && response.data) {
            // Only store if app is running (pid > 0)
            if (response.data.running && response.data.pid > 0) {
              statusMap.set(app.bundleIdentifier, response.data.pid);
            }
          }
        } catch (error) {
          console.debug(
            `Failed to get running status for app ${app.bundleIdentifier}:`,
            error
          );
        }
      })
    );

    setAppRunningStatus(statusMap);
  };

  // Filter and sort apps
  useEffect(() => {
    let filtered = apps.filter(
      (app) =>
        app.displayName.toLowerCase().includes(nameFilter.toLowerCase()) ||
        app.bundleIdentifier.toLowerCase().includes(nameFilter.toLowerCase())
    );

    // Sort by display name
    filtered = filtered.sort((a, b) => {
      return sortOrder === "asc"
        ? a.displayName.localeCompare(b.displayName)
        : b.displayName.localeCompare(a.displayName);
    });

    setFilteredApps(filtered);
  }, [apps, nameFilter, sortOrder]);

  const handleSortToggle = () => {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
  };

  const handleSpawnApp = async (app: InstalledAppInfo) => {
    setSpawningBundleId(app.bundleIdentifier);
    try {
      const client = getApiClient();

      // If there's an existing attached process, kill it first
      if (attachedProcess) {
        logInfo(
          "SPAWN",
          `Terminating existing process: ${attachedProcess.processname} (PID: ${attachedProcess.pid})`
        );
        try {
          // Kill the existing process by PID
          await client.terminateApp(attachedProcess.pid.toString());
          // Clear the attached state
          systemActions.updateField("attachedProcess", null);
          systemActions.updateField("attachedAppInfo", null);
          systemActions.updateField("spawnSuspended", false);
          systemActions.updateField("attachedModules", []);
        } catch (killError) {
          addLog(
            "WARN",
            "SPAWN",
            `Failed to terminate existing process, continuing with spawn...`
          );
        }
      }

      const response = await client.spawnApp(app.bundleIdentifier, true);

      if (response.success && response.data?.success) {
        const pid = response.data.pid;

        logInfo(
          "SPAWN",
          `Successfully spawned app: ${app.displayName} (${app.bundleIdentifier}) with PID: ${pid}`
        );

        if (pid && pid > 0) {
          // Attach to the spawned process
          await client.attachProcess(pid);

          // Get additional process information
          const appInfoResponse = await client.getProcessInfo();
          const modulesResponse = await client.enumerateModules();

          const appInfo: AppInfo = appInfoResponse.data
            ? {
                ...appInfoResponse.data,
                pid: pid,
                bundleIdentifier: app.bundleIdentifier,
              }
            : {
                name: app.displayName,
                pid: pid,
                bundleIdentifier: app.bundleIdentifier,
              };

          logInfo(
            "PROCESS",
            `Successfully attached to spawned process: ${app.displayName} (PID: ${pid})`
          );

          // Update process state with spawnSuspended flag
          systemActions.updateProcessState(
            {
              pid: pid,
              processname: app.displayName,
            },
            appInfo
          );

          // Set spawnSuspended flag
          systemActions.updateField("spawnSuspended", true);

          // Update modules
          if (onModulesUpdate && modulesResponse.data?.modules) {
            onModulesUpdate(modulesResponse.data.modules);
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
              logInfo(
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
        }

        if (response.data?.warning) {
          addLog("WARN", "SPAWN", response.data.warning);
        }

        // Update running status after spawn (PID changed)
        setAppRunningStatus((prev) => {
          const newMap = new Map(prev);
          if (response.data?.pid && response.data.pid > 0) {
            newMap.set(app.bundleIdentifier, response.data.pid);
          }
          return newMap;
        });
      } else {
        const errorMsg =
          response.data?.error || response.message || "Unknown error";
        addLog(
          "ERROR",
          "SPAWN",
          `Failed to spawn app: ${app.displayName} - ${errorMsg}`
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      addLog(
        "ERROR",
        "SPAWN",
        `Failed to spawn app: ${app.displayName} - ${errorMessage}`
      );
    } finally {
      setSpawningBundleId(null);
    }
  };

  useEffect(() => {
    if (connected) {
      loadApps();
    } else {
      setApps([]);
      setFilteredApps([]);
      setNameFilter("");
    }
  }, [connected, loadApps]);

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
      <Stack spacing={isCompactHeight ? 1.5 : 2}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
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
            <AppsIcon sx={{ fontSize: isCompactHeight ? "14px" : "16px" }} />
            Spawn Manager
          </Typography>
          <Tooltip title="Refresh app list">
            <IconButton
              onClick={loadApps}
              disabled={!connected || loading}
              size="small"
              sx={{
                color: "primary.main",
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              <RefreshIcon
                sx={{ fontSize: isCompactHeight ? "14px" : "16px" }}
              />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Attached Process Info (Application Information) */}
        {attachedProcess && (
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
                fontSize: isCompactHeight ? "10px" : "11px",
                fontWeight: 600,
                mb: isCompactHeight ? 0.5 : 1,
              }}
            >
              Application Information
            </Typography>
            <Stack spacing={isCompactHeight ? 0.25 : 0.5}>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                Name: {attachedProcess.processname}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                PID: {attachedProcess.pid}
              </Typography>
              {system.attachedAppInfo?.bundleIdentifier && (
                <Typography
                  variant="body2"
                  sx={{
                    fontSize: isCompactHeight ? "9px" : "10px",
                    wordBreak: "break-all",
                    fontFamily: "monospace",
                  }}
                >
                  Bundle ID: {system.attachedAppInfo.bundleIdentifier}
                </Typography>
              )}
              {system.attachedAppInfo && (
                <Typography
                  variant="body2"
                  sx={{
                    fontSize: isCompactHeight ? "9px" : "10px",
                    wordBreak: "break-all",
                    fontFamily: "monospace",
                  }}
                >
                  Path: {system.attachedAppInfo.name || "Unknown"}
                </Typography>
              )}
            </Stack>
          </Paper>
        )}

        {/* Filter and Controls */}
        {connected && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Autocomplete
              freeSolo
              options={filterHistory}
              inputValue={nameFilter}
              onInputChange={(_, value) => setNameFilter(value)}
              onChange={(_, value) => {
                if (value) {
                  setNameFilter(value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameFilter.trim()) {
                  addToFilterHistory(nameFilter.trim());
                }
              }}
              PaperComponent={({ children, ...props }) => (
                <Paper {...props} sx={{ backgroundColor: "#2d2d2d" }}>
                  {children}
                </Paper>
              )}
              renderOption={(props, option) => {
                const { key, ...restProps } = props as any;
                return (
                  <Box
                    key={key}
                    component="li"
                    {...restProps}
                    onMouseDown={(e: React.MouseEvent) => {
                      e.preventDefault();
                      setNameFilter(option);
                    }}
                    sx={{
                      fontSize: "11px",
                      cursor: "pointer",
                      padding: "6px 12px",
                      "&:hover": { backgroundColor: "rgba(255,255,255,0.1)" },
                    }}
                  >
                    {option}
                  </Box>
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Filter by name or bundle ID"
                  size="small"
                  sx={{
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
                        transform: "translate(14px, 6px) scale(1)",
                        "&.MuiInputLabel-shrink": {
                          transform: "translate(14px, -6px) scale(0.75)",
                        },
                      },
                    }),
                  }}
                />
              )}
              sx={{ flex: 1 }}
            />
            <Tooltip
              title={`Sort by name (${sortOrder === "asc" ? "A-Z" : "Z-A"})`}
            >
              <IconButton
                onClick={handleSortToggle}
                size="small"
                sx={{
                  color: "primary.main",
                  "&:hover": { backgroundColor: "action.hover" },
                }}
              >
                {sortOrder === "asc" ? (
                  <ArrowUpIcon
                    sx={{ fontSize: isCompactHeight ? "14px" : "16px" }}
                  />
                ) : (
                  <ArrowDownIcon
                    sx={{ fontSize: isCompactHeight ? "14px" : "16px" }}
                  />
                )}
              </IconButton>
            </Tooltip>
          </Stack>
        )}

        {/* App List */}
        <TableContainer
          component={Paper}
          sx={{
            maxHeight: isCompactHeight ? 300 : 400,
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    fontWeight: 600,
                    py: isCompactHeight ? 0.5 : 1,
                    width: "32px",
                  }}
                >
                  Icon
                </TableCell>
                <TableCell
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    fontWeight: 600,
                    py: isCompactHeight ? 0.5 : 1,
                    width: "50px",
                  }}
                >
                  PID
                </TableCell>
                <TableCell
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    fontWeight: 600,
                    py: isCompactHeight ? 0.5 : 1,
                    width: "100px",
                  }}
                >
                  App Name
                </TableCell>
                <TableCell
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    fontWeight: 600,
                    py: isCompactHeight ? 0.5 : 1,
                    width: "140px",
                  }}
                >
                  Bundle ID
                </TableCell>
                <TableCell
                  align="right"
                  sx={{
                    fontSize: isCompactHeight ? "10px" : "11px",
                    fontWeight: 600,
                    py: isCompactHeight ? 0.5 : 1,
                  }}
                >
                  Spawn
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 2 }}>
                    <CircularProgress size={24} />
                  </TableCell>
                </TableRow>
              ) : filteredApps.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 2 }}>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
                    >
                      {apps.length === 0
                        ? "No apps found. Make sure server is running on iOS device."
                        : "No apps match the filter."}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                filteredApps.map((app) => (
                  <TableRow
                    key={app.bundleIdentifier}
                    hover
                    sx={{ "&:hover": { backgroundColor: "action.hover" } }}
                  >
                    <TableCell
                      sx={{ py: isCompactHeight ? 0.5 : 1, width: "32px" }}
                    >
                      {appIcons.get(app.bundleIdentifier) ? (
                        <img
                          src={appIcons.get(app.bundleIdentifier)}
                          alt="App icon"
                          style={{
                            width: isCompactHeight ? "14px" : "16px",
                            height: isCompactHeight ? "14px" : "16px",
                            objectFit: "contain",
                            borderRadius: "3px",
                          }}
                        />
                      ) : (
                        <AppsIcon
                          sx={{
                            fontSize: isCompactHeight ? "14px" : "16px",
                            color: "text.secondary",
                          }}
                        />
                      )}
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: isCompactHeight ? "10px" : "11px",
                        py: isCompactHeight ? 0.5 : 1,
                        width: "50px",
                        fontFamily: "monospace",
                        color: appRunningStatus.has(app.bundleIdentifier)
                          ? "success.main"
                          : "text.secondary",
                      }}
                    >
                      {appRunningStatus.has(app.bundleIdentifier)
                        ? appRunningStatus.get(app.bundleIdentifier)
                        : "-"}
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: isCompactHeight ? "10px" : "11px",
                        py: isCompactHeight ? 0.5 : 1,
                        width: "100px",
                      }}
                    >
                      <Box sx={{ display: "flex", flexDirection: "column" }}>
                        <span>{app.displayName}</span>
                        {app.bundleVersion && (
                          <span style={{ color: "gray", fontSize: "8px" }}>
                            v{app.bundleVersion}
                          </span>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell
                      sx={{
                        fontSize: isCompactHeight ? "9px" : "10px",
                        py: isCompactHeight ? 0.5 : 1,
                        fontFamily: "monospace",
                        color: "text.secondary",
                        width: "140px",
                      }}
                    >
                      {app.bundleIdentifier}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ py: isCompactHeight ? 0.5 : 1 }}
                    >
                      <Tooltip title="Spawn (suspended)">
                        <IconButton
                          size="small"
                          onClick={() => handleSpawnApp(app)}
                          disabled={spawningBundleId === app.bundleIdentifier}
                          sx={{
                            color: "success.main",
                            "&:hover": { backgroundColor: "action.hover" },
                            "&:disabled": { color: "text.disabled" },
                          }}
                        >
                          {spawningBundleId === app.bundleIdentifier ? (
                            <CircularProgress
                              size={isCompactHeight ? 12 : 14}
                            />
                          ) : (
                            <SpawnIcon
                              sx={{
                                fontSize: isCompactHeight ? "12px" : "14px",
                              }}
                            />
                          )}
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {!connected && (
          <Typography
            variant="body2"
            color="text.secondary"
            align="center"
            sx={{
              mt: 2,
              fontSize: isCompactHeight ? "10px" : "11px",
            }}
          >
            Connect to server to view installed apps
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}
