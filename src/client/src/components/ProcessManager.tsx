import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Typography,
  Button,
  TextField,
  Box,
  IconButton,
  Tooltip,
  Paper,
  Stack,
  CircularProgress,
  useMediaQuery,
  Autocomplete,
} from "@mui/material";
import {
  Refresh as RefreshIcon,
  Link as AttachIcon,
  Memory as ProcessIcon,
  ArrowUpward as ArrowUpIcon,
  ArrowDownward as ArrowDownIcon,
} from "@mui/icons-material";
import { List } from "react-window";

import {
  getApiClient,
  ProcessInfo,
  ProcessState,
  AppInfo,
  ModuleInfo,
} from "../lib/api";
import { useGlobalDebugLogger } from "../hooks/useGlobalDebugLogger";
import { useAppState } from "../hooks/useAppState";

// LocalStorage key for filter history
const PROCESS_FILTER_HISTORY_KEY = "process_manager_filter_history";
const MAX_HISTORY_ITEMS = 5;

interface ProcessManagerProps {
  // Legacy props for backward compatibility, but we'll use global store instead
  onModulesUpdate?: (modules: ModuleInfo[]) => void;
}

// Row data interface for virtualized list
interface ProcessRowData {
  processes: ProcessInfo[];
  attachingPid: number | null;
  selectedPid: number | undefined;
  isCompactHeight: boolean;
  onAttach: (process: ProcessInfo) => void;
}

// Virtualized row component for react-window v2
function ProcessRow({
  index,
  style,
  ...rowProps
}: {
  index: number;
  style: React.CSSProperties;
  data: ProcessRowData;
}) {
  const data = rowProps.data as ProcessRowData;
  const { processes, attachingPid, selectedPid, isCompactHeight, onAttach } =
    data;
  const process = processes[index];
  const isSelected = selectedPid === process.pid;
  const isAttaching = attachingPid === process.pid;

  return (
    <Box
      style={style}
      sx={{
        display: "flex",
        alignItems: "center",
        px: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: isSelected ? "action.selected" : "transparent",
        "&:hover": {
          backgroundColor: isSelected ? "action.selected" : "action.hover",
        },
        cursor: "pointer",
      }}
      onClick={() => !isAttaching && !isSelected && onAttach(process)}
    >
      <Box
        sx={{
          width: "60px",
          fontSize: isCompactHeight ? "9px" : "10px",
          flexShrink: 0,
        }}
      >
        {process.pid}
      </Box>
      <Box
        sx={{
          flex: 1,
          fontSize: isCompactHeight ? "10px" : "11px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {process.processname}
      </Box>
      <Box
        sx={{
          width: "50px",
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <Tooltip title="Attach to process">
          <span>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onAttach(process);
              }}
              disabled={isAttaching || isSelected}
              sx={{
                color: "primary.main",
                padding: "2px",
                "&:hover": { backgroundColor: "action.hover" },
                "&:disabled": { color: "text.disabled" },
              }}
            >
              {isAttaching ? (
                <CircularProgress size={isCompactHeight ? 12 : 14} />
              ) : (
                <AttachIcon
                  sx={{
                    fontSize: isCompactHeight ? "12px" : "14px",
                  }}
                />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
}

export function ProcessManager({ onModulesUpdate }: ProcessManagerProps) {
  // Use new app state system
  const { system, systemActions } = useAppState();
  const connected = system.serverConnected;
  const attachedProcess = system.attachedProcess;
  const attachedAppInfo = system.attachedAppInfo;

  const isCompactHeight = useMediaQuery("(max-height: 800px)");
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [filteredProcesses, setFilteredProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [attachingPid, setAttachingPid] = useState<number | null>(null);
  const [nameFilter, setNameFilter] = useState("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [filterHistory, setFilterHistory] = useState<string[]>([]);

  // Load filter history from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PROCESS_FILTER_HISTORY_KEY);
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
      localStorage.setItem(PROCESS_FILTER_HISTORY_KEY, JSON.stringify(history));
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

  // デバッグログ機能
  const { addLog, logInfo } = useGlobalDebugLogger();

  // Derive process state from global state (useMemoで最適化)
  const processState: ProcessState = useMemo(
    () => ({
      attached: !!attachedProcess,
      processInfo: attachedProcess,
      appInfo: attachedAppInfo,
    }),
    [attachedProcess, attachedAppInfo]
  );

  // Handle process attach using app state
  const handleProcessAttach = useCallback(
    (process?: ProcessInfo, appInfo?: AppInfo) => {
      const attachedProcess = process
        ? {
            pid: process.pid,
            processname: process.processname,
          }
        : undefined;

      systemActions.updateProcessState(attachedProcess, appInfo);
    },
    [systemActions.updateProcessState]
  );

  // Debug logging - processStateの作成を避けて直接ログ出力
  useEffect(() => {
    console.log("ProcessManager - attachedProcess:", attachedProcess);
    console.log("ProcessManager - attachedAppInfo:", attachedAppInfo);
  }, [attachedProcess, attachedAppInfo]);

  const loadProcesses = useCallback(async () => {
    if (!connected) return;

    setLoading(true);
    try {
      const client = getApiClient();
      const processList = await client.enumerateProcesses();
      setProcesses(processList);
    } catch (error) {
      console.error("Failed to load processes:", error);
    } finally {
      setLoading(false);
    }
  }, [connected]);

  // Filter and sort processes
  useEffect(() => {
    let filtered = processes.filter((process) =>
      process.processname.toLowerCase().includes(nameFilter.toLowerCase())
    );

    // Sort by PID
    filtered = filtered.sort((a, b) => {
      return sortOrder === "asc" ? a.pid - b.pid : b.pid - a.pid;
    });

    setFilteredProcesses(filtered);
  }, [processes, nameFilter, sortOrder]);

  const handleSortToggle = () => {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
  };

  const handleAttachProcess = async (process: ProcessInfo) => {
    setAttachingPid(process.pid);
    try {
      const client = getApiClient();
      await client.attachProcess(process.pid);

      // Get additional process information
      const appInfoResponse = await client.getProcessInfo();
      const modulesResponse = await client.enumerateModules();

      // Extract app info from API response
      const appInfo: AppInfo = appInfoResponse.data
        ? {
            ...appInfoResponse.data,
            pid: process.pid,
          }
        : {
            name: process.processname,
            pid: process.pid,
          };

      // プロセスアタッチ成功をログに記録
      logInfo(
        "PROCESS",
        `Successfully attached to process: ${process.processname} (PID: ${process.pid})`
      );

      // モジュール情報を取得してログに出力
      if (modulesResponse.data?.modules) {
        const modules = modulesResponse.data.modules;
        logInfo(
          "MODULES",
          `Loaded ${modules.length} modules for process ${process.processname}`
        );

        // 各モジュール情報をログに出力
        modules.forEach((module, index) => {
          const moduleName = module.modulename || module.name || "Unknown";
          const baseAddress =
            module.base_address || `0x${module.base.toString(16)}`;
          const size = module.size;
          const path = module.path || "Unknown path";

          addLog("INFO", "MODULE", `Module ${index + 1}: ${moduleName}`, {
            name: moduleName,
            baseAddress: baseAddress,
            size: size,
            path: path,
            is64bit: module.is_64bit,
          });
        });

        // 一番上のモジュール（最初のモジュール）のシンボル情報を取得
        if (modules.length > 0) {
          const firstModule = modules[0];
          const moduleName =
            firstModule.modulename || firstModule.name || "Unknown";

          logInfo("SYMBOLS", `Loading symbols for first module: ${moduleName}`);

          try {
            const symbols = await client.enumerateSymbolsForModule(firstModule);
            logInfo(
              "SYMBOLS",
              `Loaded ${symbols.length} symbols for module: ${moduleName}`
            );

            // 最初の10個のシンボルをログに出力
            const symbolsToLog = symbols.slice(0, 10);
            symbolsToLog.forEach((symbol, index) => {
              addLog("INFO", "SYMBOL", `Symbol ${index + 1}: ${symbol.name}`, {
                address: symbol.address,
                name: symbol.name,
                size: symbol.size,
                type: symbol.type,
                scope: symbol.scope,
                moduleBase: symbol.module_base,
                fileName: symbol.file_name,
                lineNumber: symbol.line_number,
              });
            });

            if (symbols.length > 10) {
              logInfo("SYMBOLS", `... and ${symbols.length - 10} more symbols`);
            }
          } catch (symbolError) {
            console.error(
              "Failed to load symbols for first module:",
              symbolError
            );
            addLog(
              "ERROR",
              "SYMBOLS",
              `Failed to load symbols for module: ${moduleName}`,
              {
                error:
                  symbolError instanceof Error
                    ? symbolError.message
                    : "Unknown error",
              }
            );
          }
        }
      }

      handleProcessAttach(process, appInfo);

      // アタッチ成功時にモジュール一覧を更新
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
          logInfo("SIGNALS", "Synced default signal configurations to server");
        } catch (signalError) {
          console.error("Failed to sync signal configurations:", signalError);
          addLog(
            "WARN",
            "SIGNALS",
            "Failed to sync signal configurations to server"
          );
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to attach to process:", error);
      addLog(
        "ERROR",
        "PROCESS",
        `Failed to attach to process: ${process.processname} (PID: ${process.pid})`,
        {
          error: errorMessage,
        }
      );
    } finally {
      setAttachingPid(null);
    }
  };

  const handleDetachProcess = () => {
    if (attachedProcess) {
      logInfo(
        "PROCESS",
        `Detached from process: ${attachedProcess.processname} (PID: ${attachedProcess.pid})`
      );
    }

    // Clear process state (explicitly set to null)
    systemActions.updateField("attachedProcess", null);
    systemActions.updateField("attachedAppInfo", null);

    // Clear debug state when detaching from process
    systemActions.updateField("isInBreakState", false);
    systemActions.updateField("currentThreadId", null);
    systemActions.updateField("currentBreakAddress", null);
    systemActions.updateField("currentRegisterData", {});

    // Clear breakpoints and watchpoints when detaching from process
    systemActions.updateField("activeBreakpoints", []);
    systemActions.updateField("softwareBreakpoints", []);
    systemActions.updateField("watchpoints", []);

    // Clear modules
    systemActions.updateField("attachedModules", []);

    console.log("All debug state cleared due to process detach");
  };

  useEffect(() => {
    if (connected) {
      loadProcesses();
    } else {
      setProcesses([]);
      setFilteredProcesses([]);
      // 接続が切れた時のみプロセスのアタッチを解除 (explicitly set to null)
      // 注意: サーバーページを開いただけでは既存のattach状態を保持する
      if (!connected && (attachedProcess || attachedAppInfo)) {
        console.log("[ProcessManager] Connection lost, clearing attach state");
        systemActions.updateField("attachedProcess", null);
        systemActions.updateField("attachedAppInfo", null);
      }
      setNameFilter("");
    }
  }, [connected, loadProcesses]); // systemActionsを依存配列から削除

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
            <ProcessIcon sx={{ fontSize: isCompactHeight ? "14px" : "16px" }} />
            Process Manager
          </Typography>
          <Tooltip title="Refresh process list">
            <IconButton
              onClick={loadProcesses}
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

        {/* Attached Process Info */}
        {processState.attached && processState.processInfo && (
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
              Process Information
            </Typography>
            <Stack spacing={isCompactHeight ? 0.25 : 0.5}>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                Name: {processState.processInfo.processname}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontSize: isCompactHeight ? "9px" : "10px" }}
              >
                PID: {processState.processInfo.pid}
              </Typography>
              {processState.appInfo && (
                <Typography
                  variant="body2"
                  sx={{
                    fontSize: isCompactHeight ? "9px" : "10px",
                    wordBreak: "break-all",
                    fontFamily: "monospace",
                  }}
                >
                  Path: {processState.appInfo.name || "Unknown"}
                </Typography>
              )}
            </Stack>
            <Button
              variant="outlined"
              size="small"
              color="warning"
              onClick={handleDetachProcess}
              sx={{
                mt: isCompactHeight ? 0.5 : 1,
                fontSize: isCompactHeight ? "9px" : "10px",
                py: 0.25,
                px: 1,
                minWidth: "auto",
                "&:hover": {
                  backgroundColor: "warning.light",
                  color: "warning.contrastText",
                },
              }}
            >
              Detach
            </Button>
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
                  label="Filter by name"
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
              title={`Sort by PID (${sortOrder === "asc" ? "Low to High" : "High to Low"})`}
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

        {/* Process List - Virtualized */}
        <Paper
          sx={{
            border: "1px solid",
            borderColor: "divider",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              borderBottom: "1px solid",
              borderColor: "divider",
              backgroundColor: "background.paper",
              px: 1,
              py: isCompactHeight ? 0.5 : 1,
            }}
          >
            <Box
              sx={{
                width: "60px",
                fontSize: isCompactHeight ? "10px" : "11px",
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              PID
            </Box>
            <Box
              sx={{
                flex: 1,
                fontSize: isCompactHeight ? "10px" : "11px",
                fontWeight: 600,
              }}
            >
              Name
            </Box>
            <Box
              sx={{
                width: "50px",
                fontSize: isCompactHeight ? "10px" : "11px",
                fontWeight: 600,
                textAlign: "right",
              }}
            >
              Actions
            </Box>
          </Box>

          {/* Virtualized List */}
          {loading ? (
            <Box
              sx={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                py: 2,
                height: isCompactHeight ? 300 : 400,
              }}
            >
              <CircularProgress size={24} />
            </Box>
          ) : filteredProcesses.length === 0 ? (
            <Box
              sx={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                py: 2,
                height: 100,
              }}
            >
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ fontSize: isCompactHeight ? "10px" : "11px" }}
              >
                No processes found
              </Typography>
            </Box>
          ) : (
            <List
              style={{ height: isCompactHeight ? 300 : 400 }}
              rowCount={filteredProcesses.length}
              rowHeight={isCompactHeight ? 28 : 32}
              rowProps={{
                data: {
                  processes: filteredProcesses,
                  attachingPid,
                  selectedPid: processState.processInfo?.pid,
                  isCompactHeight,
                  onAttach: handleAttachProcess,
                },
              }}
              rowComponent={ProcessRow as any}
            />
          )}
        </Paper>

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
            Connect to server to view processes
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}
