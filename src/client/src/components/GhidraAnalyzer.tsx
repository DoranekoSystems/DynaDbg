import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  Paper,
  Alert,
  LinearProgress,
  IconButton,
  Tooltip,
  InputAdornment,
  Chip,
  CircularProgress,
  Autocomplete,
} from "@mui/material";
import {
  Settings as SettingsIcon,
  PlayArrow as PlayArrowIcon,
  Check as CheckIcon,
  Error as ErrorIcon,
  Info as InfoIcon,
  Refresh as RefreshIcon,
  Extension as ExtensionIcon,
  Folder as FolderIcon,
} from "@mui/icons-material";
import { invoke } from "@tauri-apps/api/core";
import { getApiClient, ModuleInfo } from "../lib/api";
import { useUIStore } from "../stores/uiStore";

// LocalStorage keys
const GHIDRA_PATH_KEY = "dynadbg_ghidra_path";
const GHIDRA_ANALYZED_LIBS_KEY = "dynadbg_analyzed_libraries";

interface GhidraAnalyzerProps {
  serverConnected: boolean;
  targetOs?: string;
}

interface AnalysisLog {
  timestamp: number;
  type: "info" | "error" | "success" | "output";
  message: string;
}

interface AnalyzedLibrary {
  libraryPath: string;
  localPath: string;
  projectPath: string;
  analyzedAt: number;
  functions?: Array<{ name: string; address: string; size: number }>;
}

interface GhidraAnalysisStatus {
  library_path: string;
  analyzed: boolean;
  project_path: string | null;
  error: string | null;
}

// Helper function to get module path - use path field, or modulename if it looks like a path
const getModulePath = (module: ModuleInfo): string | null => {
  if (module.path) {
    return module.path;
  }
  // Check if modulename looks like a path (starts with / or contains path separators)
  const modulename = module.modulename || module.name || "";
  if (
    modulename.startsWith("/") ||
    modulename.includes("/") ||
    modulename.includes("\\")
  ) {
    return modulename;
  }
  return null;
};

export const GhidraAnalyzer: React.FC<GhidraAnalyzerProps> = ({
  serverConnected,
  targetOs,
}) => {
  // Get persisted state from uiStore
  const toolsState = useUIStore((state) => state.toolsState);
  const updateToolsState = useUIStore(
    (state) => state.actions.updateToolsState
  );

  // Ghidra path settings - use uiStore for persistence
  const [ghidraPath, setGhidraPath] = useState<string>(() => {
    return toolsState.ghidraPath || localStorage.getItem(GHIDRA_PATH_KEY) || "";
  });
  const [ghidraPathInput, setGhidraPathInput] = useState<string>(ghidraPath);
  const [isPathValid, setIsPathValid] = useState<boolean | null>(null);

  // Ghidra project name - for organizing analyzed libraries
  const GHIDRA_PROJECT_NAME_KEY = "dynadbg_ghidra_project_name";
  const [projectName, setProjectName] = useState<string>(() => {
    return (
      toolsState.ghidraProjectName ||
      localStorage.getItem(GHIDRA_PROJECT_NAME_KEY) ||
      ""
    );
  });
  const [projectNameInput, setProjectNameInput] = useState<string>(projectName);

  // Module list - use uiStore for persistence
  const modules = toolsState.ghidraModules || [];
  const setModules = useCallback(
    (newModules: ModuleInfo[]) => {
      updateToolsState({ ghidraModules: newModules });
    },
    [updateToolsState]
  );
  const [moduleFilter] = useState<string>(toolsState.ghidraModuleFilter || "");
  const [selectedModule, setSelectedModule] = useState<ModuleInfo | null>(null);
  const [isLoadingModules, setIsLoadingModules] = useState(false);

  // Analysis state - use uiStore for persistence
  const [isAnalyzing, setIsAnalyzing] = useState(
    toolsState.ghidraIsAnalyzing || false
  );

  // Ghidra server state - use uiStore for persistence across tab switches
  const serverStatus = toolsState.ghidraServerStatus || "stopped";
  const serverPort = toolsState.ghidraServerPort;
  const serverProjectPath = toolsState.ghidraServerProjectPath;

  const setServerStatus = useCallback(
    (status: "stopped" | "starting" | "running" | "stopping") => {
      updateToolsState({ ghidraServerStatus: status });
    },
    [updateToolsState]
  );

  const setServerPort = useCallback(
    (port: number | null) => {
      updateToolsState({ ghidraServerPort: port });
    },
    [updateToolsState]
  );

  const setServerProjectPath = useCallback(
    (path: string | null) => {
      updateToolsState({ ghidraServerProjectPath: path });
    },
    [updateToolsState]
  );

  const [analysisProgress, setAnalysisProgress] = useState<string>(
    toolsState.ghidraAnalysisProgress || ""
  );
  const [analysisLogs, setAnalysisLogs] = useState<AnalysisLog[]>(
    toolsState.ghidraAnalysisLogs || []
  );
  const [analyzedLibraries, setAnalyzedLibraries] = useState<
    Map<string, AnalyzedLibrary>
  >(() => {
    try {
      const saved = localStorage.getItem(GHIDRA_ANALYZED_LIBS_KEY);
      if (saved) {
        const libs: AnalyzedLibrary[] = JSON.parse(saved);
        const map = new Map<string, AnalyzedLibrary>();
        libs.forEach((lib) => map.set(lib.libraryPath, lib));
        return map;
      }
    } catch (e) {
      console.error("Failed to load analyzed libraries:", e);
    }
    return new Map();
  });

  // Log output ref for auto-scroll
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Sync state to uiStore when it changes
  useEffect(() => {
    updateToolsState({
      ghidraModuleFilter: moduleFilter,
      ghidraAnalysisLogs: analysisLogs,
      ghidraAnalysisProgress: analysisProgress,
      ghidraIsAnalyzing: isAnalyzing,
      ghidraSelectedModuleBase: selectedModule?.base || null,
    });
  }, [
    moduleFilter,
    analysisLogs,
    analysisProgress,
    isAnalyzing,
    selectedModule,
    updateToolsState,
  ]);

  // Restore selected module from uiStore when modules are loaded
  useEffect(() => {
    if (modules.length > 0 && toolsState.ghidraSelectedModuleBase !== null) {
      const savedModule = modules.find(
        (m) => m.base === toolsState.ghidraSelectedModuleBase
      );
      if (savedModule && !selectedModule) {
        setSelectedModule(savedModule);
      }
    }
  }, [modules, toolsState.ghidraSelectedModuleBase]);

  // Add log entry
  const addLog = useCallback((type: AnalysisLog["type"], message: string) => {
    setAnalysisLogs((prev) => [
      ...prev,
      { timestamp: Date.now(), type, message },
    ]);
  }, []);

  // Clear logs
  const clearLogs = useCallback(() => {
    setAnalysisLogs([]);
  }, []);

  // Validate Ghidra path
  const pathValidationLoggedRef = useRef<string | null>(null);
  const initialPathValidationDoneRef = useRef(false);
  const validateGhidraPath = useCallback(
    async (path: string, silent: boolean = false) => {
      if (!path) {
        setIsPathValid(null);
        return;
      }

      try {
        // Check if analyzeHeadless exists
        const isWindows = navigator.platform.toLowerCase().includes("win");
        const analyzerPath = isWindows
          ? `${path}/support/analyzeHeadless.bat`
          : `${path}/support/analyzeHeadless`;

        const exists = await invoke<boolean>("path_exists", {
          path: analyzerPath,
        });
        setIsPathValid(exists);

        // Only log once per path to avoid duplicates, and skip success log if silent
        if (pathValidationLoggedRef.current !== path) {
          pathValidationLoggedRef.current = path;
          if (!exists) {
            addLog(
              "error",
              `Ghidra analyzeHeadless not found at: ${analyzerPath}`
            );
          } else if (!silent) {
            addLog("info", `Ghidra path validated successfully`);
          }
        }
      } catch (e) {
        setIsPathValid(false);
        if (pathValidationLoggedRef.current !== path) {
          pathValidationLoggedRef.current = path;
          addLog("error", `Failed to validate Ghidra path: ${e}`);
        }
      }
    },
    [addLog]
  );

  // Save Ghidra path to localStorage and uiStore
  const saveGhidraPath = useCallback(() => {
    localStorage.setItem(GHIDRA_PATH_KEY, ghidraPathInput);
    setGhidraPath(ghidraPathInput);
    updateToolsState({ ghidraPath: ghidraPathInput });
    // Note: addLog will be called after validation
    validateGhidraPath(ghidraPathInput);
  }, [ghidraPathInput, updateToolsState, validateGhidraPath]);

  // Save project name to localStorage and uiStore
  const saveProjectName = useCallback(() => {
    const name = projectNameInput.trim();
    if (!name) {
      addLog("error", "Project name cannot be empty");
      return;
    }
    // Validate project name (alphanumeric, underscores, hyphens only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      addLog(
        "error",
        "Project name can only contain letters, numbers, underscores, and hyphens"
      );
      return;
    }
    localStorage.setItem(GHIDRA_PROJECT_NAME_KEY, name);
    setProjectName(name);
    updateToolsState({ ghidraProjectName: name });
    addLog("success", `Project name saved: ${name}`);
  }, [projectNameInput, updateToolsState, addLog]);

  // Note: Directory browser not available - user needs to manually input path

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [analysisLogs]);

  // Load modules from server
  const loadModules = useCallback(async () => {
    if (!serverConnected) {
      setModules([]);
      return;
    }

    setIsLoadingModules(true);
    try {
      const api = getApiClient();
      const result = await api.enumerateModules();
      if (result.success && result.data?.modules) {
        setModules(result.data.modules);
        addLog("info", `Loaded ${result.data.modules.length} modules`);
      }
    } catch (e) {
      console.error("Failed to load modules:", e);
      addLog("error", `Failed to load modules: ${e}`);
    } finally {
      setIsLoadingModules(false);
    }
  }, [serverConnected, addLog]);

  // Load modules only when explicitly requested (via Refresh button)
  // Removed auto-load on server connection

  // Auto-load modules when server is connected and modules list is empty
  useEffect(() => {
    if (serverConnected && modules.length === 0) {
      loadModules();
    }
  }, [serverConnected, modules.length, loadModules]);

  // Validate path on initial load (silent to avoid log spam on every tab switch)
  useEffect(() => {
    if (ghidraPath && !initialPathValidationDoneRef.current) {
      initialPathValidationDoneRef.current = true;
      validateGhidraPath(ghidraPath, true);
    }
  }, [ghidraPath, validateGhidraPath]);

  // Check if module is an iOS system module (dyld_shared_cache)
  const isIosSystemModule = useCallback(
    (module: ModuleInfo): boolean => {
      if (targetOs !== "ios" && targetOs !== "iOS") return false;
      const path = getModulePath(module);
      if (!path) return false;
      // iOS system libraries from dyld_shared_cache typically have paths like:
      // /usr/lib/..., /System/Library/..., or no actual file on disk
      return (
        path.startsWith("/usr/lib/") ||
        path.startsWith("/System/Library/") ||
        path.startsWith("/Developer/") ||
        // Libraries in shared cache often have these patterns
        path.includes("/PrivateFrameworks/") ||
        (path.startsWith("/") &&
          !path.includes("/var/") &&
          !path.includes("/private/"))
      );
    },
    [targetOs]
  );

  // Check if a module has server running (moved before filteredModules)
  const getModuleServerStatus = useCallback(
    (modulePath: string): { running: boolean; port: number | null } => {
      if (serverStatus !== "running" || !serverProjectPath) {
        return { running: false, port: null };
      }
      const libInfo = analyzedLibraries.get(modulePath);
      if (libInfo?.projectPath === serverProjectPath) {
        return { running: true, port: serverPort };
      }
      return { running: false, port: null };
    },
    [serverStatus, serverProjectPath, serverPort, analyzedLibraries]
  );

  // Check if module is already analyzed
  const isModuleAnalyzed = useCallback(
    (modulePath: string): boolean => {
      const normalizedPath = modulePath.replace(/\\/g, "/").toLowerCase();
      for (const [key] of analyzedLibraries) {
        if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
          return true;
        }
      }
      return false;
    },
    [analyzedLibraries]
  );

  // Filter and sort modules
  // Sorting priority: 1. Server running, 2. Analyzed, 3. Others
  const filteredModules = useMemo(() => {
    let result = modules;

    // Apply filter
    if (moduleFilter) {
      const filter = moduleFilter.toLowerCase();
      result = result.filter(
        (m) =>
          m.modulename?.toLowerCase().includes(filter) ||
          m.path?.toLowerCase().includes(filter)
      );
    }

    // Sort: server running > analyzed > others
    return [...result].sort((a, b) => {
      const pathA = getModulePath(a);
      const pathB = getModulePath(b);

      const serverA = pathA ? getModuleServerStatus(pathA).running : false;
      const serverB = pathB ? getModuleServerStatus(pathB).running : false;
      const analyzedA = pathA ? isModuleAnalyzed(pathA) : false;
      const analyzedB = pathB ? isModuleAnalyzed(pathB) : false;

      // Server running modules first
      if (serverA && !serverB) return -1;
      if (!serverA && serverB) return 1;

      // Then analyzed modules
      if (analyzedA && !analyzedB) return -1;
      if (!analyzedA && analyzedB) return 1;

      // Then by name
      const nameA = (a.modulename || a.name || "").toLowerCase();
      const nameB = (b.modulename || b.name || "").toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [modules, moduleFilter, getModuleServerStatus, isModuleAnalyzed]);

  // Check if selected module is a WASM module (Ghidra doesn't support WASM)
  const isSelectedModuleWasm = useMemo(() => {
    if (!selectedModule) return false;
    const modulePath = getModulePath(selectedModule);
    if (!modulePath) return false;
    return modulePath.toLowerCase() === "wasm" || 
           selectedModule.modulename?.toLowerCase().includes("wasm") ||
           modulePath.toLowerCase().endsWith(".wasm");
  }, [selectedModule]);

  // Save analyzed libraries
  const saveAnalyzedLibraries = useCallback(
    (libs: Map<string, AnalyzedLibrary>) => {
      const libsArray = Array.from(libs.values());
      localStorage.setItem(GHIDRA_ANALYZED_LIBS_KEY, JSON.stringify(libsArray));
      setAnalyzedLibraries(libs);
    },
    []
  );

  // Analyze selected module with Ghidra
  const analyzeModule = useCallback(async () => {
    const modulePath = selectedModule ? getModulePath(selectedModule) : null;
    if (!selectedModule || !modulePath) {
      addLog("error", "No module selected or module has no path");
      return;
    }

    if (!ghidraPath) {
      addLog("error", "Ghidra path not configured");
      return;
    }

    setIsAnalyzing(true);
    clearLogs();
    addLog("info", `Starting analysis of: ${selectedModule.modulename}`);
    addLog("info", `Library path: ${modulePath}`);
    addLog("info", `Ghidra path: ${ghidraPath}`);

    try {
      let localPath: string;

      // Check if this is a WASM module (path is "wasm" or modulename contains "wasm")
      const isWasmModule = modulePath.toLowerCase() === "wasm" || 
                           selectedModule.modulename?.toLowerCase().includes("wasm");

      if (isWasmModule) {
        // WASM mode: Download binary from Chrome extension via /api/wasm/dump
        setAnalysisProgress("Downloading WASM binary from browser...");
        addLog("info", "Fetching WASM binary from Chrome extension...");

        const apiClient = getApiClient();
        const wasmBinary = await apiClient.dumpWasmBinary();
        
        if (!wasmBinary || wasmBinary.byteLength === 0) {
          throw new Error("Failed to download WASM binary - no data received");
        }

        addLog("success", `Downloaded WASM binary: ${wasmBinary.byteLength} bytes`);

        // Verify WASM magic number
        const header = new Uint8Array(wasmBinary.slice(0, 4));
        const isValidWasm = header[0] === 0x00 && header[1] === 0x61 && 
                           header[2] === 0x73 && header[3] === 0x6d; // \0asm
        if (!isValidWasm) {
          addLog("info", `Warning: Binary doesn't have WASM magic number (got: ${Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ')})`);
        } else {
          addLog("info", "Valid WASM binary (magic: \\0asm)");
        }

        // Save WASM binary to local file (same location as native libraries)
        setAnalysisProgress("Saving WASM binary to disk...");
        const binaryArray = Array.from(new Uint8Array(wasmBinary));
        localPath = await invoke<string>("save_wasm_binary", {
          binaryData: binaryArray,
          moduleName: selectedModule.modulename || "wasm_module",
          projectName: projectName || null,
        });

        addLog("success", `Saved to: ${localPath}`);
      } else {
        // Native mode: Download library from server
        setAnalysisProgress("Downloading library from server...");
        addLog("info", "Downloading library from server...");

        localPath = await invoke<string>("download_library_file", {
          libraryPath: modulePath,
          projectName: projectName || null,
        });

        addLog("success", `Downloaded to: ${localPath}`);
      }

      // Step 2: Run Ghidra analysis
      setAnalysisProgress(
        "Running Ghidra analysis (this may take several minutes)..."
      );
      addLog("info", "Starting Ghidra headless analysis...");
      addLog(
        "info",
        "This process may take several minutes depending on library size."
      );
      addLog("info", `Project: ${projectName}`);

      // Start the analysis with project name
      const result = await invoke<GhidraAnalysisStatus>("analyze_with_ghidra", {
        localLibraryPath: localPath,
        ghidraPath: ghidraPath,
        projectName: projectName || null,
      });

      if (result.analyzed && result.project_path) {
        addLog("success", "Analysis completed successfully!");
        addLog("info", `Project path: ${result.project_path}`);

        // Step 3: Get function list from the analyzed library
        setAnalysisProgress("Fetching function list...");
        addLog("info", "Fetching function list from Ghidra...");

        // Use localPath (the actual analyzed file) for library name, not modulePath
        // This is important for WASM mode where localPath is the actual .wasm file
        const pathParts = localPath.split(/[/\\]/);
        const libraryName = pathParts[pathParts.length - 1];

        let functions: Array<{ name: string; address: string; size: number }> =
          [];
        try {
          const funcResult = await invoke<{
            success: boolean;
            functions: Array<{ name: string; address: string; size: number }>;
            error: string | null;
          }>("ghidra_get_functions", {
            projectPath: result.project_path,
            libraryName: libraryName,
            ghidraPath: ghidraPath,
          });

          if (funcResult.success) {
            functions = funcResult.functions;
            addLog("success", `Found ${functions.length} functions`);

            // Save functions to SQLite database
            try {
              const osKey = targetOs || "unknown";
              await invoke("save_ghidra_functions", {
                targetOs: osKey,
                moduleName: libraryName,
                functionsJson: JSON.stringify(functions),
              });
              addLog("info", `Functions saved to database (OS: ${osKey})`);
            } catch (dbError) {
              addLog("info", `Could not save to database: ${dbError}`);
            }
          } else {
            addLog("info", `Could not fetch functions: ${funcResult.error}`);
          }
        } catch (funcError) {
          addLog("info", `Could not fetch functions: ${funcError}`);
        }

        // Save to analyzed libraries with functions
        const newLibs = new Map(analyzedLibraries);
        newLibs.set(modulePath, {
          libraryPath: modulePath,
          localPath: localPath,
          projectPath: result.project_path,
          analyzedAt: Date.now(),
          functions: functions,
        });
        saveAnalyzedLibraries(newLibs);

        setAnalysisProgress("Analysis completed!");
      } else {
        addLog("error", `Analysis failed: ${result.error || "Unknown error"}`);
        setAnalysisProgress("Analysis failed");
      }
    } catch (e) {
      addLog("error", `Analysis error: ${e}`);
      setAnalysisProgress("Analysis failed");
    } finally {
      setIsAnalyzing(false);
    }
  }, [
    selectedModule,
    ghidraPath,
    addLog,
    clearLogs,
    analyzedLibraries,
    saveAnalyzedLibraries,
    targetOs,
  ]);

  // Start Ghidra HTTP server for fast decompile/xref (based on selected module)
  const startServer = useCallback(async () => {
    if (!ghidraPath) {
      addLog("error", "Ghidra path not configured");
      return;
    }

    if (!selectedModule) {
      addLog("error", "No module selected");
      return;
    }

    const modulePath = getModulePath(selectedModule);
    if (!modulePath) {
      addLog("error", "Module has no path");
      return;
    }

    const libInfo = analyzedLibraries.get(modulePath);
    if (!libInfo?.projectPath) {
      addLog("error", "Module not analyzed. Please analyze first.");
      return;
    }

    // If a different server is already running, stop it first
    if (serverProjectPath && serverProjectPath !== libInfo.projectPath) {
      addLog("info", "Stopping existing Ghidra server...");
      try {
        await invoke<boolean>("stop_ghidra_server", {
          projectPath: serverProjectPath,
        });
        setServerPort(null);
        setServerProjectPath(null);
        addLog("success", "Previous server stopped");
      } catch (e) {
        addLog("error", `Failed to stop existing server: ${e}`);
        // Continue anyway
      }
    }

    const pathParts = modulePath.split(/[/\\]/);
    const libraryName = pathParts[pathParts.length - 1];

    setServerStatus("starting");
    addLog("info", `Starting Ghidra HTTP server for: ${libraryName}`);
    addLog("info", "Loading Ghidra project... This may take 30-60 seconds.");

    try {
      const port = 18462;
      const result = await invoke<boolean>("start_ghidra_server", {
        projectPath: libInfo.projectPath,
        libraryName: libraryName,
        ghidraPath: ghidraPath,
        port: port,
      });

      if (result) {
        // Wait for server to be ready (poll for up to 120 seconds)
        let ready = false;
        let lastLogCount = 0;
        for (let i = 0; i < 600; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (i % 10 === 0 && i > 0) {
            addLog("info", `Still waiting for server... (${i}s)`);
            // Fetch and display new server logs periodically
            try {
              const logs = await invoke<string[]>("get_ghidra_server_logs", {
                projectPath: libInfo.projectPath,
              });
              if (logs && logs.length > lastLogCount) {
                const newLogs = logs.slice(lastLogCount);
                newLogs.forEach((log) => addLog("output", log));
                lastLogCount = logs.length;
              }
            } catch {
              // Ignore log fetch errors
            }
          }
          try {
            const portCheck = await invoke<number | null>(
              "check_ghidra_server",
              {
                projectPath: libInfo.projectPath,
              }
            );
            if (portCheck !== null) {
              ready = true;
              setServerPort(portCheck);
              break;
            }
          } catch {
            // Server not ready yet, keep waiting
          }
        }

        if (ready) {
          setServerStatus("running");
          setServerProjectPath(libInfo.projectPath);
          addLog("success", `Ghidra server started on port ${port}`);
          addLog("info", "Fast decompile/xref is now available!");
        } else {
          setServerStatus("stopped");
          addLog("error", "Server failed to start within timeout (600s)");
          addLog(
            "info",
            "Try checking the Ghidra project or restart the application."
          );
          // Fetch and display server logs for debugging
          try {
            const logs = await invoke<string[]>("get_ghidra_server_logs", {
              projectPath: libInfo.projectPath,
            });
            if (logs && logs.length > 0) {
              addLog("info", "--- Ghidra Server Logs ---");
              const lastLogs = logs.slice(-20); // Show last 20 lines
              lastLogs.forEach((log) => addLog("output", log));
              addLog("info", "--- End of Logs ---");
            }
          } catch (logError) {
            addLog("error", `Failed to retrieve server logs: ${logError}`);
          }
        }
      } else {
        setServerStatus("stopped");
        addLog("error", "Failed to start Ghidra server");
      }
    } catch (e) {
      setServerStatus("stopped");
      addLog("error", `Failed to start server: ${e}`);
    }
  }, [ghidraPath, selectedModule, analyzedLibraries, addLog]);

  // Stop Ghidra server
  const stopServer = useCallback(async () => {
    if (!serverProjectPath) return;

    setServerStatus("stopping");
    addLog("info", "Stopping Ghidra server...");

    try {
      await invoke<boolean>("stop_ghidra_server", {
        projectPath: serverProjectPath,
      });
      setServerStatus("stopped");
      setServerPort(null);
      setServerProjectPath(null);
      addLog("success", "Ghidra server stopped");
    } catch (e) {
      addLog("error", `Failed to stop server: ${e}`);
      setServerStatus("stopped");
    }
  }, [serverProjectPath, addLog]);

  // Check if selected module is analyzed
  const isSelectedModuleAnalyzed = useMemo(() => {
    if (!selectedModule) return false;
    const modulePath = getModulePath(selectedModule);
    if (!modulePath) return false;
    const libInfo = analyzedLibraries.get(modulePath);
    return libInfo?.functions && libInfo.functions.length > 0;
  }, [selectedModule, analyzedLibraries]);

  // Check if selected module has server running
  const isSelectedModuleServerRunning = useMemo(() => {
    if (!selectedModule) return false;
    const modulePath = getModulePath(selectedModule);
    if (!modulePath) return false;
    return getModuleServerStatus(modulePath).running;
  }, [selectedModule, getModuleServerStatus]);

  // Get Ghidra projects directory
  const getGhidraProjectsDir = useCallback((): string => {
    // This should match the path in lib.rs: LocalAppData/DynaDbg/ghidra_projects
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();

    if (platform.includes("win")) {
      return "%LOCALAPPDATA%\\DynaDbg\\ghidra_projects";
    } else if (platform.includes("linux") || userAgent.includes("linux")) {
      return "~/.local/share/DynaDbg/ghidra_projects";
    } else {
      return "~/Library/Application Support/DynaDbg/ghidra_projects";
    }
  }, []);

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "auto",
        minHeight: 0,
        p: 2,
        gap: 2,
        "@media (max-height: 800px)": {
          p: 0.75,
          gap: 0.75,
        },
        "&::-webkit-scrollbar": {
          width: "8px",
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
      }}
    >
      {/* Settings Section */}
      <Paper
        sx={{
          p: 2,
          backgroundColor: "background.default",
          flexShrink: 0,
          "@media (max-height: 800px)": {
            p: 0.75,
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            mb: 2,
            "@media (max-height: 800px)": {
              mb: 0.75,
            },
          }}
        >
          <SettingsIcon
            sx={{
              fontSize: 18,
              color: "primary.main",
              "@media (max-height: 800px)": { fontSize: 14 },
            }}
          />
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              "@media (max-height: 800px)": { fontSize: "11px" },
            }}
          >
            Ghidra Settings
          </Typography>
        </Box>

        {/* Ghidra Path Input */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            mb: 2,
            "@media (max-height: 800px)": { mb: 0.75, gap: 0.5 },
          }}
        >
          <TextField
            size="small"
            label="Ghidra Installation Path"
            placeholder="e.g., C:\\ghidra_11.2.1_PUBLIC or /opt/ghidra"
            value={ghidraPathInput}
            onChange={(e) => setGhidraPathInput(e.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <ExtensionIcon
                    sx={{ fontSize: 16, color: "text.secondary" }}
                  />
                </InputAdornment>
              ),
              endAdornment: isPathValid !== null && (
                <InputAdornment position="end">
                  {isPathValid ? (
                    <CheckIcon sx={{ fontSize: 16, color: "success.main" }} />
                  ) : (
                    <ErrorIcon sx={{ fontSize: 16, color: "error.main" }} />
                  )}
                </InputAdornment>
              ),
            }}
            sx={{
              flex: 1,
              "@media (max-height: 800px)": {
                "& .MuiInputBase-root": { height: 28 },
                "& .MuiInputLabel-root": { fontSize: "11px" },
                "& .MuiInputBase-input": { fontSize: "11px" },
              },
            }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={saveGhidraPath}
            disabled={!ghidraPathInput}
            sx={{
              "@media (max-height: 800px)": {
                fontSize: "10px",
                py: 0.25,
                px: 1,
                minWidth: "auto",
              },
            }}
          >
            Save
          </Button>
        </Box>

        {/* Project Name Input */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            mb: 2,
            "@media (max-height: 800px)": { mb: 0.75, gap: 0.5 },
          }}
        >
          <TextField
            size="small"
            label="Project Name"
            placeholder="e.g., my_ios_app, android_ctf"
            value={projectNameInput}
            onChange={(e) => setProjectNameInput(e.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <FolderIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                </InputAdornment>
              ),
              endAdornment: projectName && (
                <InputAdornment position="end">
                  <CheckIcon sx={{ fontSize: 16, color: "success.main" }} />
                </InputAdornment>
              ),
            }}
            helperText="Unique name for this project. Libraries will be stored under this folder."
            sx={{
              flex: 1,
              "@media (max-height: 800px)": {
                "& .MuiInputBase-root": { height: 28 },
                "& .MuiInputLabel-root": { fontSize: "11px" },
                "& .MuiInputBase-input": { fontSize: "11px" },
                "& .MuiFormHelperText-root": { fontSize: "9px", mt: 0.25 },
              },
            }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={saveProjectName}
            disabled={!projectNameInput.trim()}
            sx={{
              "@media (max-height: 800px)": {
                fontSize: "10px",
                py: 0.25,
                px: 1,
                minWidth: "auto",
              },
            }}
          >
            Save
          </Button>
        </Box>

        {/* Warning if project name is not set */}
        {!projectName && (
          <Alert
            severity="warning"
            sx={{
              py: 0.5,
              mb: 2,
              "& .MuiAlert-message": { fontSize: "11px" },
              "@media (max-height: 800px)": {
                py: 0.25,
                mb: 0.75,
                "& .MuiAlert-message": { fontSize: "9px" },
              },
            }}
          >
            <Typography variant="caption">
              Please set a project name before analyzing modules. This helps
              organize files from different targets.
            </Typography>
          </Alert>
        )}

        {/* Info about file storage location */}
        <Alert
          severity="info"
          sx={{
            py: 0.5,
            "& .MuiAlert-message": { fontSize: "11px" },
          }}
          icon={<InfoIcon sx={{ fontSize: 16 }} />}
        >
          <Typography variant="caption">
            <strong>Data Storage Location:</strong> Ghidra project files and
            downloaded libraries are stored in:
            <br />
            <code
              style={{
                backgroundColor: "rgba(0,0,0,0.1)",
                padding: "2px 6px",
                borderRadius: 4,
                fontSize: "10px",
              }}
            >
              {getGhidraProjectsDir()}
            </code>
          </Typography>
        </Alert>
      </Paper>

      {/* Module Selection Section */}
      <Paper
        sx={{
          p: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
          backgroundColor: "background.default",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Select Module
          </Typography>
          <Tooltip title="Refresh modules">
            <IconButton
              onClick={loadModules}
              disabled={isLoadingModules || !serverConnected}
              size="small"
            >
              <RefreshIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          {isLoadingModules && <CircularProgress size={16} />}
        </Box>

        {/* iOS system module explanation */}
        {(targetOs === "ios" || targetOs === "iOS") && (
          <Alert
            severity="info"
            sx={{
              py: 0.25,
              "& .MuiAlert-message": { fontSize: "10px" },
            }}
            icon={<InfoIcon sx={{ fontSize: 14 }} />}
          >
            <Typography variant="caption">
              Grayed-out modules are iOS system libraries stored in
              dyld_shared_cache. These cannot be analyzed as they don't exist as
              individual files on disk.
            </Typography>
          </Alert>
        )}

        {!serverConnected ? (
          <Alert severity="warning" sx={{ py: 0.5 }}>
            Not connected to server. Please connect to a server first.
          </Alert>
        ) : (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Autocomplete
              size="small"
              options={filteredModules}
              value={selectedModule}
              onChange={(_event, newValue) => {
                if (newValue && !isIosSystemModule(newValue)) {
                  setSelectedModule(newValue);
                }
              }}
              getOptionLabel={(option) => {
                const moduleName =
                  option.modulename || option.name || "Unknown";
                return moduleName.split("/").pop() || moduleName;
              }}
              getOptionDisabled={(option) => isIosSystemModule(option)}
              isOptionEqualToValue={(option, value) =>
                option.base === value.base
              }
              filterOptions={(options, { inputValue }) => {
                if (!inputValue) return options;
                const filter = inputValue.toLowerCase();
                return options.filter(
                  (m) =>
                    m.modulename?.toLowerCase().includes(filter) ||
                    m.path?.toLowerCase().includes(filter)
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Select Module..."
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      fontSize: "12px",
                    },
                  }}
                />
              )}
              renderOption={(props, option) => {
                const moduleName =
                  option.modulename || option.name || "Unknown";
                const fileName = moduleName.split("/").pop() || moduleName;
                const modulePath = getModulePath(option);
                const isAnalyzed = modulePath
                  ? isModuleAnalyzed(modulePath)
                  : false;
                const moduleServerStatus = modulePath
                  ? getModuleServerStatus(modulePath)
                  : { running: false, port: null };
                const isSystemModule = isIosSystemModule(option);

                return (
                  <li
                    {...props}
                    key={option.base}
                    style={{
                      ...props.style,
                      opacity: isSystemModule ? 0.5 : 1,
                      fontSize: "12px",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span style={{ flex: 1 }}>{fileName}</span>
                    {moduleServerStatus.running && (
                      <Chip
                        label={`Server :${moduleServerStatus.port}`}
                        size="small"
                        color="primary"
                        sx={{
                          height: 16,
                          fontSize: 9,
                          "& .MuiChip-label": { px: 0.5 },
                        }}
                      />
                    )}
                    {isAnalyzed && !moduleServerStatus.running && (
                      <Chip
                        label="Analyzed"
                        size="small"
                        color="success"
                        sx={{
                          height: 16,
                          fontSize: 9,
                          "& .MuiChip-label": { px: 0.5 },
                        }}
                      />
                    )}
                    {isSystemModule && (
                      <Chip
                        label="System"
                        size="small"
                        sx={{
                          height: 16,
                          fontSize: 9,
                          backgroundColor: "rgba(128,128,128,0.3)",
                          color: "text.disabled",
                          "& .MuiChip-label": { px: 0.5 },
                        }}
                      />
                    )}
                    {option.size && (
                      <span style={{ fontSize: 9, color: "#888" }}>
                        {(option.size / 1024).toFixed(0)}K
                      </span>
                    )}
                  </li>
                );
              }}
              sx={{ flex: 1, minWidth: 250 }}
              noOptionsText={
                modules.length === 0
                  ? "No modules. Click refresh to load."
                  : "No modules match."
              }
            />
            {selectedModule && (
              <>
                {(() => {
                  const modulePath = getModulePath(selectedModule);
                  const moduleServerStatus = modulePath
                    ? getModuleServerStatus(modulePath)
                    : { running: false, port: null };
                  const isAnalyzed = modulePath
                    ? isModuleAnalyzed(modulePath)
                    : false;

                  return (
                    <>
                      {moduleServerStatus.running && (
                        <Chip
                          label={`Server Running :${moduleServerStatus.port}`}
                          size="small"
                          color="primary"
                          sx={{ height: 20, fontSize: 10 }}
                        />
                      )}
                      {isAnalyzed && !moduleServerStatus.running && (
                        <Chip
                          label="Analyzed"
                          size="small"
                          color="success"
                          sx={{ height: 20, fontSize: 10 }}
                        />
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </Box>
        )}

        {/* Analyze Button */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            backgroundColor: "background.paper",
            flexWrap: "wrap",
          }}
        >
          <Tooltip
            title={
              isSelectedModuleWasm
                ? "Ghidra does not support WebAssembly analysis"
                : !selectedModule
                ? "Select a module to analyze"
                : !ghidraPath
                ? "Configure Ghidra path first"
                : !projectName
                ? "Enter a project name"
                : !serverConnected
                ? "Connect to server first"
                : ""
            }
            arrow
          >
            <span>
              <Button
                variant="contained"
                color="primary"
                startIcon={<PlayArrowIcon />}
                onClick={analyzeModule}
                disabled={
                  !selectedModule ||
                  !getModulePath(selectedModule) ||
                  !ghidraPath ||
                  !projectName ||
                  isAnalyzing ||
                  !serverConnected ||
                  isSelectedModuleWasm
                }
                sx={{ 
                  minWidth: 120,
                  ...(isSelectedModuleWasm && {
                    opacity: 0.5,
                  }),
                }}
              >
                {isAnalyzing ? "Analyzing..." : isSelectedModuleWasm ? "Not Supported" : "Analyze"}
              </Button>
            </span>
          </Tooltip>
          {/* Start/Stop Server button - only show for analyzed modules */}
          {isSelectedModuleAnalyzed &&
            (isSelectedModuleServerRunning ? (
              <Button
                variant="outlined"
                color="error"
                onClick={stopServer}
                disabled={serverStatus === "stopping"}
                sx={{ minWidth: 120 }}
              >
                {serverStatus === "stopping" ? "Stopping..." : "Stop Server"}
              </Button>
            ) : (
              <Button
                variant="outlined"
                color="primary"
                onClick={startServer}
                disabled={
                  serverStatus === "starting" ||
                  serverStatus === "running" ||
                  isAnalyzing
                }
                sx={{ minWidth: 120 }}
                startIcon={
                  serverStatus === "starting" ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : null
                }
              >
                {serverStatus === "starting" ? "Starting..." : "Start Server"}
              </Button>
            ))}
          {selectedModule && (
            <Typography
              variant="caption"
              sx={{
                color: getModulePath(selectedModule)
                  ? "text.secondary"
                  : "warning.main",
                flex: 1,
              }}
            >
              Selected: {selectedModule.modulename || selectedModule.name}
              {!getModulePath(selectedModule) &&
                " (no path available - cannot analyze)"}
            </Typography>
          )}
          {/* Warning when module is analyzed but server not running */}
          {isSelectedModuleAnalyzed && !isSelectedModuleServerRunning && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                backgroundColor: "rgba(255, 152, 0, 0.1)",
                border: "1px solid rgba(255, 152, 0, 0.3)",
                borderRadius: 1,
                px: 1.5,
                py: 0.5,
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  color: "warning.main",
                  fontWeight: 500,
                }}
              >
                ⚠ Server not running - Decompile/Xref will be slow. Click
                "Start Server" for faster analysis.
              </Typography>
            </Box>
          )}
        </Box>
      </Paper>

      {/* Analysis Output Section */}
      <Paper
        sx={{
          height: 350,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          backgroundColor: "background.default",
        }}
      >
        <Box
          sx={{
            p: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 600, flex: 1 }}>
            Analysis Output
          </Typography>
          {isAnalyzing && (
            <Box sx={{ flex: 1, mx: 2 }}>
              <LinearProgress variant="indeterminate" />
            </Box>
          )}
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {analysisProgress}
          </Typography>
          <Button size="small" onClick={clearLogs}>
            Clear
          </Button>
        </Box>

        <Box
          ref={logContainerRef}
          sx={{
            flex: 1,
            overflow: "auto",
            p: 1,
            fontFamily: "monospace",
            fontSize: "11px",
            backgroundColor: "#1a1a1a",
            minHeight: 0,
            "&::-webkit-scrollbar": {
              width: "8px",
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
          }}
        >
          {analysisLogs.map((log, index) => (
            <Box
              key={index}
              sx={{
                display: "flex",
                gap: 1,
                mb: 0.5,
                color:
                  log.type === "error"
                    ? "#f44336"
                    : log.type === "success"
                      ? "#4caf50"
                      : log.type === "output"
                        ? "#90caf9"
                        : "#e0e0e0",
              }}
            >
              <Typography
                variant="caption"
                sx={{ color: "text.disabled", fontFamily: "monospace" }}
              >
                [{new Date(log.timestamp).toLocaleTimeString()}]
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}
              >
                {log.message}
              </Typography>
            </Box>
          ))}
          {analysisLogs.length === 0 && (
            <Typography
              variant="caption"
              sx={{ color: "text.disabled", fontStyle: "italic" }}
            >
              Analysis output will appear here...
            </Typography>
          )}
        </Box>
      </Paper>
    </Box>
  );
};

export default GhidraAnalyzer;
