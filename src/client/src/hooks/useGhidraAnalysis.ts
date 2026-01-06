import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore } from "../stores/uiStore";

export interface GhidraAnalysisStatus {
  library_path: string;
  analyzed: boolean;
  project_path: string | null;
  error: string | null;
}

export interface GhidraTokenInfo {
  text: string;
  line: number;
  col_start: number;
  col_end: number;
  token_type: "function" | "variable" | "type" | "field" | "data" | "unknown";
  target_offset?: string; // For function calls - offset of the called function
  target_name?: string; // For function calls - name of the called function
  var_name?: string; // For variables
  data_type?: string; // For variables/types
  is_parameter?: boolean; // For variables
}

export interface GhidraDecompileResult {
  success: boolean;
  function_name: string | null;
  address: string | null;
  decompiled_code: string | null;
  line_mapping: Record<string, string> | null; // line number (as string) -> offset (hex string)
  tokens?: GhidraTokenInfo[] | null; // Token information for syntax highlighting
  error: string | null;
}

export interface XrefEntry {
  from_address: string;
  from_function: string | null;
  from_function_offset?: string | null;
  ref_type: string;
  instruction?: string | null;
}

export interface GhidraXrefsResult {
  success: boolean;
  target_function: string;
  target_address: string;
  xrefs: XrefEntry[];
  error: string | null;
}

export interface GhidraFunctionEntry {
  name: string;
  address: string; // offset from image base as hex string
  size: number;
}

export interface GhidraFunctionListResult {
  success: boolean;
  functions: GhidraFunctionEntry[];
  error: string | null;
}

export interface GhidraVariableInfo {
  name: string;
  data_type: string;
  storage: string;
  is_parameter: boolean;
  size: number;
}

export interface GhidraCalledFunction {
  name: string;
  offset: string;
}

export interface GhidraFunctionInfoResult {
  success: boolean;
  function_name: string | null;
  function_offset: string | null;
  variables: GhidraVariableInfo[];
  called_functions: GhidraCalledFunction[];
  error: string | null;
}

// CFG (Control Flow Graph) types from Ghidra analysis
export interface GhidraCfgInstruction {
  address: string;
  bytes: string;
  opcode: string;
  operands: string;
}

export interface GhidraCfgBlock {
  id: string;
  startAddress: string;
  endAddress: string;
  instructions: GhidraCfgInstruction[];
  successors: string[];
  predecessors: string[];
  isEntry: boolean;
  isExit: boolean;
}

export interface GhidraCfgEdge {
  from: string;
  to: string;
  type: string; // "normal" | "conditional-true" | "conditional-false" | "unconditional"
}

export interface GhidraCfgResult {
  success: boolean;
  function_name: string | null;
  function_offset: string | null;
  blocks: GhidraCfgBlock[];
  edges: GhidraCfgEdge[];
  error: string | null;
}

// Block reachability analysis types (Z3-based)
export interface BlockReachability {
  blockId: string;
  startAddress: string;
  endAddress: string;
  status: "current" | "reachable" | "unreachable" | "conditional" | "unknown";
  condition: string;
  probability?: number;
  pathConditions?: string[];
}

export interface ReachabilityResult {
  success: boolean;
  functionName: string | null;
  functionOffset: string | null;
  currentBlock: string | null;
  blocks: BlockReachability[];
  error: string | null;
}

// Ghidra Data item types
export interface GhidraDataItem {
  address: string;
  name: string | null;
  type: string;
  category:
    | "string"
    | "pointer"
    | "integer"
    | "float"
    | "struct"
    | "array"
    | "other";
  size: number;
  value: string | null;
}

export interface GhidraDataResult {
  success: boolean;
  data: GhidraDataItem[];
  total: number;
  truncated: boolean;
  error: string | null;
}

interface AnalyzedLibrary {
  libraryPath: string;
  localPath: string;
  projectPath: string;
  analyzedAt: number;
  functions?: GhidraFunctionEntry[]; // Cached function list
}

const ANALYZED_LIBS_KEY = "dynadbg_analyzed_libraries";

export const useGhidraAnalysis = () => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDecompiling, setIsDecompiling] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string>("");
  const [analyzedLibraries, setAnalyzedLibraries] = useState<
    Map<string, AnalyzedLibrary>
  >(new Map());
  const [lastDecompileResult, setLastDecompileResult] =
    useState<GhidraDecompileResult | null>(null);

  // Server state from uiStore for persistence
  const toolsState = useUIStore((state) => state.toolsState);
  const updateToolsState = useUIStore(
    (state) => state.actions.updateToolsState
  );

  const serverRunning = toolsState.ghidraServerStatus === "running";
  const serverPort = toolsState.ghidraServerPort;
  const serverProjectPath = toolsState.ghidraServerProjectPath;

  const abortControllerRef = useRef<AbortController | null>(null);

  // Load analyzed libraries from localStorage
  useEffect(() => {
    try {
      const savedLibs = localStorage.getItem(ANALYZED_LIBS_KEY);
      if (savedLibs) {
        const libsArray: AnalyzedLibrary[] = JSON.parse(savedLibs);
        const libsMap = new Map<string, AnalyzedLibrary>();
        libsArray.forEach((lib) => libsMap.set(lib.libraryPath, lib));
        setAnalyzedLibraries(libsMap);
      }
    } catch (e) {
      console.error("Failed to load Ghidra analyzed libraries:", e);
    }
  }, []);

  // Save analyzed libraries to localStorage
  const saveAnalyzedLibraries = useCallback(
    (libs: Map<string, AnalyzedLibrary>) => {
      const libsArray = Array.from(libs.values());
      localStorage.setItem(ANALYZED_LIBS_KEY, JSON.stringify(libsArray));
      setAnalyzedLibraries(libs);
    },
    []
  );

  // Check if a library is already analyzed
  const isLibraryAnalyzed = useCallback(
    (libraryPath: string): boolean => {
      if (!libraryPath) return false;
      // Normalize path for comparison
      const normalizedPath = libraryPath.replace(/\\/g, "/").toLowerCase();

      // First try exact path match
      for (const [key] of analyzedLibraries) {
        if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
          return true;
        }
      }

      // Then try matching by filename only
      const getFileName = (p: string) => {
        const parts = p.replace(/\\/g, "/").split("/");
        return parts[parts.length - 1].toLowerCase();
      };
      const targetFileName = getFileName(libraryPath);

      for (const [key] of analyzedLibraries) {
        if (getFileName(key) === targetFileName) {
          return true;
        }
      }

      return false;
    },
    [analyzedLibraries]
  );

  // Get analyzed library info
  const getAnalyzedLibraryInfo = useCallback(
    (libraryPath: string): AnalyzedLibrary | null => {
      if (!libraryPath) return null;
      const normalizedPath = libraryPath.replace(/\\/g, "/").toLowerCase();

      // First try exact path match
      for (const [key, value] of analyzedLibraries) {
        if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
          return value;
        }
      }

      // Then try matching by filename only
      const getFileName = (p: string) => {
        const parts = p.replace(/\\/g, "/").split("/");
        return parts[parts.length - 1].toLowerCase();
      };
      const targetFileName = getFileName(libraryPath);

      for (const [key, value] of analyzedLibraries) {
        if (getFileName(key) === targetFileName) {
          return value;
        }
      }

      return null;
    },
    [analyzedLibraries]
  );

  // Download library from server
  const downloadLibrary = useCallback(
    async (remoteLibraryPath: string): Promise<string | null> => {
      try {
        setAnalysisProgress("Downloading library from server...");
        const localPath = await invoke<string>("download_library_file", {
          libraryPath: remoteLibraryPath,
        });
        return localPath;
      } catch (e) {
        console.error("Failed to download library:", e);
        setAnalysisProgress(`Error: Failed to download library - ${e}`);
        return null;
      }
    },
    []
  );

  // Analyze library with Ghidra
  const analyzeLibrary = useCallback(
    async (
      remoteLibraryPath: string,
      ghidraPath: string
    ): Promise<GhidraAnalysisStatus | null> => {
      console.log("[useGhidraAnalysis] analyzeLibrary called");
      console.log("[useGhidraAnalysis] remoteLibraryPath:", remoteLibraryPath);
      console.log("[useGhidraAnalysis] ghidraPath:", ghidraPath);

      if (!ghidraPath) {
        console.log("[useGhidraAnalysis] Error: Ghidra path not provided");
        setAnalysisProgress("Error: Ghidra path not provided");
        return null;
      }

      setIsAnalyzing(true);
      setAnalysisProgress("Starting analysis...");

      try {
        // Step 1: Download library
        console.log("[useGhidraAnalysis] Step 1: Downloading library...");
        const localPath = await downloadLibrary(remoteLibraryPath);
        console.log("[useGhidraAnalysis] Downloaded to localPath:", localPath);
        if (!localPath) {
          console.log("[useGhidraAnalysis] Download failed, localPath is null");
          setIsAnalyzing(false);
          return null;
        }

        // Step 2: Run Ghidra analysis
        console.log("[useGhidraAnalysis] Step 2: Running Ghidra analysis...");
        setAnalysisProgress(
          "Running Ghidra analysis (this may take several minutes)..."
        );
        console.log("[useGhidraAnalysis] Invoking analyze_with_ghidra with:", {
          localLibraryPath: localPath,
          ghidraPath: ghidraPath,
        });
        const result = await invoke<GhidraAnalysisStatus>(
          "analyze_with_ghidra",
          {
            localLibraryPath: localPath,
            ghidraPath: ghidraPath,
          }
        );
        console.log(
          "[useGhidraAnalysis] analyze_with_ghidra returned:",
          result
        );

        if (result.analyzed && result.project_path) {
          console.log(
            "[useGhidraAnalysis] Analysis succeeded, project_path:",
            result.project_path
          );
          // Save to analyzed libraries
          const newLibs = new Map(analyzedLibraries);
          newLibs.set(remoteLibraryPath, {
            libraryPath: remoteLibraryPath,
            localPath: localPath,
            projectPath: result.project_path,
            analyzedAt: Date.now(),
          });
          saveAnalyzedLibraries(newLibs);
          setAnalysisProgress("Analysis completed successfully!");
        } else {
          console.log(
            "[useGhidraAnalysis] Analysis failed, error:",
            result.error
          );
          setAnalysisProgress(
            `Analysis failed: ${result.error || "Unknown error"}`
          );
        }

        setIsAnalyzing(false);
        return result;
      } catch (e) {
        console.error("[useGhidraAnalysis] Exception during analysis:", e);
        setAnalysisProgress(`Error: ${e}`);
        setIsAnalyzing(false);
        return null;
      }
    },
    [downloadLibrary, analyzedLibraries, saveAnalyzedLibraries]
  );

  // Decompile a function
  const decompileFunction = useCallback(
    async (
      libraryPath: string,
      functionAddress: string,
      ghidraPath: string
    ): Promise<GhidraDecompileResult | null> => {
      if (!ghidraPath) {
        return {
          success: false,
          function_name: "",
          address: functionAddress,
          decompiled_code: null,
          line_mapping: null,
          error: "Ghidra path not provided",
        };
      }

      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          function_name: "",
          address: functionAddress,
          decompiled_code: null,
          line_mapping: null,
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      setIsDecompiling(true);

      try {
        // Extract library filename
        const pathParts = libraryPath.split(/[/\\]/);
        const libraryName = pathParts[pathParts.length - 1];

        // Check if server is running for this project
        if (serverRunning && serverProjectPath === libInfo.projectPath) {
          // Use fast server mode
          console.log("[Ghidra] Using server mode for decompile");
          const result = await invoke<GhidraDecompileResult>(
            "ghidra_server_decompile",
            {
              projectPath: libInfo.projectPath,
              functionAddress: functionAddress,
            }
          );
          setLastDecompileResult(result);
          setIsDecompiling(false);
          return result;
        }

        // Fallback to regular mode
        const result = await invoke<GhidraDecompileResult>("ghidra_decompile", {
          projectPath: libInfo.projectPath,
          libraryName: libraryName,
          functionAddress: functionAddress,
          ghidraPath: ghidraPath,
        });

        setLastDecompileResult(result);
        setIsDecompiling(false);
        return result;
      } catch (e) {
        console.error("Failed to decompile function:", e);
        const errorResult: GhidraDecompileResult = {
          success: false,
          function_name: "",
          address: functionAddress,
          decompiled_code: null,
          line_mapping: null,
          error: String(e),
        };
        setLastDecompileResult(errorResult);
        setIsDecompiling(false);
        return errorResult;
      }
    },
    [getAnalyzedLibraryInfo, serverRunning, serverProjectPath]
  );

  // Check analysis status (used to verify if analysis exists on disk)
  const checkAnalysisStatus = useCallback(
    async (libraryName: string): Promise<GhidraAnalysisStatus | null> => {
      try {
        const result = await invoke<GhidraAnalysisStatus>(
          "check_ghidra_analysis",
          {
            libraryName: libraryName,
          }
        );
        return result;
      } catch (e) {
        console.error("Failed to check analysis status:", e);
        return null;
      }
    },
    []
  );

  // Remove analyzed library from cache
  const removeAnalyzedLibrary = useCallback(
    (libraryPath: string) => {
      const newLibs = new Map(analyzedLibraries);
      const normalizedPath = libraryPath.replace(/\\/g, "/").toLowerCase();
      for (const [key] of analyzedLibraries) {
        if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
          newLibs.delete(key);
          break;
        }
      }
      saveAnalyzedLibraries(newLibs);
    },
    [analyzedLibraries, saveAnalyzedLibraries]
  );

  // Cancel ongoing analysis
  const cancelAnalysis = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsAnalyzing(false);
    setIsDecompiling(false);
    setAnalysisProgress("Analysis cancelled");
  }, []);

  // Get cross-references to a function
  const getXrefs = useCallback(
    async (
      libraryPath: string,
      functionAddress: string,
      ghidraPath: string
    ): Promise<GhidraXrefsResult | null> => {
      if (!ghidraPath) {
        return {
          success: false,
          target_function: "",
          target_address: functionAddress,
          xrefs: [],
          error: "Ghidra path not provided",
        };
      }

      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          target_function: "",
          target_address: functionAddress,
          xrefs: [],
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      try {
        const pathParts = libraryPath.split(/[/\\]/);
        const libraryName = pathParts[pathParts.length - 1];

        // Check if server is running for this project
        if (serverRunning && serverProjectPath === libInfo.projectPath) {
          // Use fast server mode
          console.log("[Ghidra] Using server mode for xrefs");
          const result = await invoke<GhidraXrefsResult>(
            "ghidra_server_xrefs",
            {
              projectPath: libInfo.projectPath,
              functionAddress: functionAddress,
            }
          );
          return result;
        }

        // Fallback to regular mode
        const result = await invoke<GhidraXrefsResult>("ghidra_get_xrefs", {
          projectPath: libInfo.projectPath,
          libraryName: libraryName,
          functionAddress: functionAddress,
          ghidraPath: ghidraPath,
        });

        return result;
      } catch (e) {
        console.error("Failed to get xrefs:", e);
        return {
          success: false,
          target_function: "",
          target_address: functionAddress,
          xrefs: [],
          error: String(e),
        };
      }
    },
    [getAnalyzedLibraryInfo, serverRunning, serverProjectPath]
  );

  // Save functions to SQLite database
  const saveFunctionsToDb = useCallback(
    async (
      targetOs: string,
      moduleName: string,
      functions: GhidraFunctionEntry[]
    ): Promise<boolean> => {
      try {
        const functionsJson = JSON.stringify(functions);
        await invoke("save_ghidra_functions", {
          targetOs,
          moduleName,
          functionsJson,
        });
        return true;
      } catch (e) {
        console.error("Failed to save functions to SQLite:", e);
        return false;
      }
    },
    []
  );

  // Load functions from SQLite database
  const loadFunctionsFromDb = useCallback(
    async (
      targetOs: string,
      moduleName: string
    ): Promise<GhidraFunctionEntry[] | null> => {
      try {
        const functionsJson = await invoke<string | null>(
          "get_ghidra_functions",
          {
            targetOs,
            moduleName,
          }
        );
        if (functionsJson) {
          return JSON.parse(functionsJson) as GhidraFunctionEntry[];
        }
        return null;
      } catch (e) {
        console.error("Failed to load functions from SQLite:", e);
        return null;
      }
    },
    []
  );

  // Get function list from an analyzed library
  const getFunctions = useCallback(
    async (
      libraryPath: string,
      ghidraPath: string,
      targetOs?: string
    ): Promise<GhidraFunctionListResult | null> => {
      if (!ghidraPath) {
        return {
          success: false,
          functions: [],
          error: "Ghidra path not provided",
        };
      }

      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          functions: [],
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      const pathParts = libraryPath.split(/[/\\]/);
      const libraryName = pathParts[pathParts.length - 1];
      const osKey = targetOs || "unknown";

      // Check if we have cached functions in SQLite first
      const cachedFunctions = await loadFunctionsFromDb(osKey, libraryName);
      if (cachedFunctions && cachedFunctions.length > 0) {
        // Also update in-memory cache
        const newLibs = new Map(analyzedLibraries);
        const normalizedPath = libraryPath.replace(/\\/g, "/").toLowerCase();
        for (const [key, value] of analyzedLibraries) {
          if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
            newLibs.set(key, { ...value, functions: cachedFunctions });
            break;
          }
        }
        setAnalyzedLibraries(newLibs);

        return {
          success: true,
          functions: cachedFunctions,
          error: null,
        };
      }

      try {
        const result = await invoke<GhidraFunctionListResult>(
          "ghidra_get_functions",
          {
            projectPath: libInfo.projectPath,
            libraryName: libraryName,
            ghidraPath: ghidraPath,
          }
        );

        // Save to SQLite and update in-memory cache
        if (result.success && result.functions.length > 0) {
          await saveFunctionsToDb(osKey, libraryName, result.functions);

          const newLibs = new Map(analyzedLibraries);
          const normalizedPath = libraryPath.replace(/\\/g, "/").toLowerCase();
          for (const [key, value] of analyzedLibraries) {
            if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
              newLibs.set(key, { ...value, functions: result.functions });
              break;
            }
          }
          setAnalyzedLibraries(newLibs);
        }

        return result;
      } catch (e) {
        console.error("Failed to get functions:", e);
        return {
          success: false,
          functions: [],
          error: String(e),
        };
      }
    },
    [
      getAnalyzedLibraryInfo,
      analyzedLibraries,
      loadFunctionsFromDb,
      saveFunctionsToDb,
    ]
  );

  // Get cached functions for a library (without fetching from Ghidra)
  const getCachedFunctions = useCallback(
    (libraryPath: string): GhidraFunctionEntry[] | null => {
      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo || !libInfo.functions) {
        return null;
      }
      return libInfo.functions;
    },
    [getAnalyzedLibraryInfo]
  );

  // Get cached functions asynchronously (checks SQLite if not in memory)
  const getCachedFunctionsAsync = useCallback(
    async (
      libraryPath: string,
      targetOs?: string
    ): Promise<GhidraFunctionEntry[] | null> => {
      // First check in-memory cache
      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (libInfo?.functions && libInfo.functions.length > 0) {
        return libInfo.functions;
      }

      // Then check SQLite
      const pathParts = libraryPath.split(/[/\\]/);
      const libraryName = pathParts[pathParts.length - 1];
      const osKey = targetOs || "unknown";

      const dbFunctions = await loadFunctionsFromDb(osKey, libraryName);
      if (dbFunctions && dbFunctions.length > 0) {
        // Update in-memory cache
        if (libInfo) {
          const newLibs = new Map(analyzedLibraries);
          const normalizedPath = libraryPath.replace(/\\/g, "/").toLowerCase();
          for (const [key, value] of analyzedLibraries) {
            if (key.replace(/\\/g, "/").toLowerCase() === normalizedPath) {
              newLibs.set(key, { ...value, functions: dbFunctions });
              break;
            }
          }
          setAnalyzedLibraries(newLibs);
        }
        return dbFunctions;
      }

      return null;
    },
    [getAnalyzedLibraryInfo, loadFunctionsFromDb, analyzedLibraries]
  );

  // Resolve function name from offset
  const resolveFunctionName = useCallback(
    (libraryPath: string, offset: number): string | null => {
      const functions = getCachedFunctions(libraryPath);
      if (!functions) return null;

      const offsetHex = `0x${offset.toString(16)}`;

      // First try exact match
      const exactMatch = functions.find((f) => f.address === offsetHex);
      if (exactMatch) return exactMatch.name;

      // Then try to find function containing this offset
      for (const func of functions) {
        const funcOffset = parseInt(func.address, 16);
        if (offset >= funcOffset && offset < funcOffset + func.size) {
          return func.name;
        }
      }

      return null;
    },
    [getCachedFunctions]
  );

  // Save decompile result to cache
  const saveDecompileToCache = useCallback(
    async (
      targetOs: string,
      moduleName: string,
      functionAddress: string,
      functionName: string,
      decompiledCode: string,
      lineMapping?: Record<number, string> | null
    ): Promise<boolean> => {
      try {
        const lineMappingJson = lineMapping
          ? JSON.stringify(lineMapping)
          : null;
        await invoke("save_decompile_cache", {
          targetOs,
          moduleName,
          functionAddress,
          functionName,
          decompiledCode,
          lineMappingJson,
        });
        return true;
      } catch (e) {
        console.error("Failed to save decompile to cache:", e);
        return false;
      }
    },
    []
  );

  // Get decompile result from cache
  const getDecompileFromCache = useCallback(
    async (
      targetOs: string,
      moduleName: string,
      functionAddress: string
    ): Promise<GhidraDecompileResult | null> => {
      try {
        const result = await invoke<GhidraDecompileResult | null>(
          "get_decompile_cache",
          {
            targetOs,
            moduleName,
            functionAddress,
          }
        );
        return result;
      } catch (e) {
        console.error("Failed to get decompile from cache:", e);
        return null;
      }
    },
    []
  );

  // Save xref result to cache
  const saveXrefToCache = useCallback(
    async (
      targetOs: string,
      moduleName: string,
      functionAddress: string,
      functionName: string,
      xrefs: XrefEntry[]
    ): Promise<boolean> => {
      try {
        const xrefsJson = JSON.stringify(xrefs);
        await invoke("save_xref_cache", {
          targetOs,
          moduleName,
          functionAddress,
          functionName,
          xrefsJson,
        });
        return true;
      } catch (e) {
        console.error("Failed to save xref to cache:", e);
        return false;
      }
    },
    []
  );

  // Get xref result from cache
  const getXrefFromCache = useCallback(
    async (
      targetOs: string,
      moduleName: string,
      functionAddress: string
    ): Promise<GhidraXrefsResult | null> => {
      try {
        const result = await invoke<GhidraXrefsResult | null>(
          "get_xref_cache",
          {
            targetOs,
            moduleName,
            functionAddress,
          }
        );
        return result;
      } catch (e) {
        console.error("Failed to get xref from cache:", e);
        return null;
      }
    },
    []
  );

  // Start Ghidra HTTP server for fast decompile/xref
  const startGhidraServer = useCallback(
    async (
      projectPath: string,
      libraryName: string,
      ghidraPath: string,
      port: number = 18462
    ): Promise<boolean> => {
      try {
        const result = await invoke<boolean>("start_ghidra_server", {
          projectPath,
          libraryName,
          ghidraPath,
          port,
        });
        if (result) {
          updateToolsState({
            ghidraServerStatus: "running",
            ghidraServerPort: port,
            ghidraServerProjectPath: projectPath,
          });
        }
        return result;
      } catch (e) {
        console.error("Failed to start Ghidra server:", e);
        return false;
      }
    },
    [updateToolsState]
  );

  // Stop Ghidra server
  const stopGhidraServer = useCallback(
    async (projectPath: string): Promise<boolean> => {
      try {
        const result = await invoke<boolean>("stop_ghidra_server", {
          projectPath,
        });
        if (result) {
          updateToolsState({
            ghidraServerStatus: "stopped",
            ghidraServerPort: null,
            ghidraServerProjectPath: null,
          });
        }
        return result;
      } catch (e) {
        console.error("Failed to stop Ghidra server:", e);
        return false;
      }
    },
    [updateToolsState]
  );

  // Check if Ghidra server is running
  const checkGhidraServer = useCallback(
    async (projectPath: string): Promise<number | null> => {
      try {
        const port = await invoke<number | null>("check_ghidra_server", {
          projectPath,
        });
        if (port !== null) {
          updateToolsState({
            ghidraServerStatus: "running",
            ghidraServerPort: port,
            ghidraServerProjectPath: projectPath,
          });
        } else {
          updateToolsState({
            ghidraServerStatus: "stopped",
            ghidraServerPort: null,
            ghidraServerProjectPath: null,
          });
        }
        return port;
      } catch (e) {
        console.error("Failed to check Ghidra server:", e);
        return null;
      }
    },
    [updateToolsState]
  );

  // Fast decompile using running Ghidra server
  const serverDecompile = useCallback(
    async (
      projectPath: string,
      functionAddress: string
    ): Promise<GhidraDecompileResult | null> => {
      try {
        const result = await invoke<GhidraDecompileResult>(
          "ghidra_server_decompile",
          {
            projectPath,
            functionAddress,
          }
        );
        return result;
      } catch (e) {
        console.error("Server decompile failed:", e);
        return null;
      }
    },
    []
  );

  // Fast xrefs using running Ghidra server
  const serverXrefs = useCallback(
    async (
      projectPath: string,
      functionAddress: string
    ): Promise<GhidraXrefsResult | null> => {
      try {
        const result = await invoke<GhidraXrefsResult>("ghidra_server_xrefs", {
          projectPath,
          functionAddress,
        });
        return result;
      } catch (e) {
        console.error("Server xrefs failed:", e);
        return null;
      }
    },
    []
  );

  // Get function info (variables and called functions) using running Ghidra server
  const getFunctionInfo = useCallback(
    async (
      libraryPath: string,
      functionAddress: string
    ): Promise<GhidraFunctionInfoResult | null> => {
      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          function_name: null,
          function_offset: null,
          variables: [],
          called_functions: [],
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      // Check if server is running for this project
      if (serverRunning && serverProjectPath === libInfo.projectPath) {
        try {
          const result = await invoke<GhidraFunctionInfoResult>(
            "ghidra_server_function_info",
            {
              projectPath: libInfo.projectPath,
              functionAddress,
            }
          );
          return result;
        } catch (e) {
          console.error("Server function info failed:", e);
          return {
            success: false,
            function_name: null,
            function_offset: null,
            variables: [],
            called_functions: [],
            error: String(e),
          };
        }
      }

      return {
        success: false,
        function_name: null,
        function_offset: null,
        variables: [],
        called_functions: [],
        error: "Ghidra server not running. Please start the server first.",
      };
    },
    [getAnalyzedLibraryInfo, serverRunning, serverProjectPath]
  );

  // Get CFG (Control Flow Graph) for a function using running Ghidra server
  const getCfg = useCallback(
    async (
      libraryPath: string,
      functionAddress: string
    ): Promise<GhidraCfgResult | null> => {
      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          function_name: null,
          function_offset: null,
          blocks: [],
          edges: [],
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      // Check if server is running for this project
      if (serverRunning && serverProjectPath === libInfo.projectPath) {
        try {
          console.log("[Ghidra] Getting CFG for function at", functionAddress);
          const result = await invoke<GhidraCfgResult>("ghidra_server_cfg", {
            projectPath: libInfo.projectPath,
            functionAddress,
          });
          console.log("[Ghidra] CFG result:", result);
          return result;
        } catch (e) {
          console.error("Server CFG failed:", e);
          return {
            success: false,
            function_name: null,
            function_offset: null,
            blocks: [],
            edges: [],
            error: String(e),
          };
        }
      }

      return {
        success: false,
        function_name: null,
        function_offset: null,
        blocks: [],
        edges: [],
        error: "Ghidra server not running. Please start the server first.",
      };
    },
    [getAnalyzedLibraryInfo, serverRunning, serverProjectPath]
  );

  // Get Data items (strings, variables, constants) using running Ghidra server
  const getData = useCallback(
    async (libraryPath: string): Promise<GhidraDataResult | null> => {
      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          data: [],
          total: 0,
          truncated: false,
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      // Check if server is running for this project
      if (serverRunning && serverProjectPath === libInfo.projectPath) {
        try {
          console.log("[Ghidra] Getting Data items for library", libraryPath);
          const result = await invoke<GhidraDataResult>("ghidra_server_data", {
            projectPath: libInfo.projectPath,
          });
          console.log("[Ghidra] Data result:", result);
          return result;
        } catch (e) {
          console.error("Server Data failed:", e);
          return {
            success: false,
            data: [],
            total: 0,
            truncated: false,
            error: String(e),
          };
        }
      }

      return {
        success: false,
        data: [],
        total: 0,
        truncated: false,
        error: "Ghidra server not running. Please start the server first.",
      };
    },
    [getAnalyzedLibraryInfo, serverRunning, serverProjectPath]
  );

  // Analyze block reachability using Z3 constraint solver
  // Register values are now passed from UI instead of fetching via API
  const analyzeReachability = useCallback(
    async (
      libraryPath: string,
      functionOffset: string,
      currentBlockOffset: string,
      dbgsrvUrl: string, // URL of dbgsrv for memory access
      authToken: string, // Authentication token for dbgsrv API
      ghidraPath: string,
      registersJson: string, // JSON string of register values from breakpoint UI (e.g., {"x0": "0x1234", ...})
      libraryBaseAddress: string // Base address of the library in memory (e.g., "0x71d7d93000")
    ): Promise<ReachabilityResult> => {
      const libInfo = getAnalyzedLibraryInfo(libraryPath);
      if (!libInfo) {
        return {
          success: false,
          functionName: null,
          functionOffset: null,
          currentBlock: null,
          blocks: [],
          error: "Library not analyzed. Please analyze with Ghidra first.",
        };
      }

      try {
        console.log(
          "[Ghidra] Analyzing reachability for block at",
          currentBlockOffset
        );
        console.log("[Ghidra] dbgsrv URL:", dbgsrvUrl);
        console.log("[Ghidra] Library base address:", libraryBaseAddress);
        console.log("[Ghidra] Registers JSON length:", registersJson.length);
        const result = await invoke<ReachabilityResult>(
          "ghidra_analyze_reachability",
          {
            projectPath: libInfo.projectPath,
            libraryName: libraryPath,
            functionOffset,
            currentBlockOffset,
            dbgsrvUrl,
            authToken,
            ghidraPath,
            registersJson,
            libraryBaseAddress,
          }
        );
        console.log("[Ghidra] Reachability result:", result);
        return result;
      } catch (e) {
        console.error("Reachability analysis failed:", e);
        return {
          success: false,
          functionName: null,
          functionOffset: null,
          currentBlock: null,
          blocks: [],
          error: String(e),
        };
      }
    },
    [getAnalyzedLibraryInfo]
  );

  return {
    // State
    isAnalyzing,
    isDecompiling,
    analysisProgress,
    analyzedLibraries,
    lastDecompileResult,
    // Server state
    serverRunning,
    serverPort,
    serverProjectPath,

    // Actions
    isLibraryAnalyzed,
    getAnalyzedLibraryInfo,
    analyzeLibrary,
    decompileFunction,
    getXrefs,
    getFunctions,
    getCachedFunctions,
    getCachedFunctionsAsync,
    saveFunctionsToDb,
    loadFunctionsFromDb,
    resolveFunctionName,
    checkAnalysisStatus,
    removeAnalyzedLibrary,
    cancelAnalysis,
    // Cache functions
    saveDecompileToCache,
    getDecompileFromCache,
    saveXrefToCache,
    getXrefFromCache,
    // Server mode functions
    startGhidraServer,
    stopGhidraServer,
    checkGhidraServer,
    serverDecompile,
    serverXrefs,
    getFunctionInfo,
    getCfg,
    getData,
    // Z3 reachability analysis
    analyzeReachability,
  };
};

export default useGhidraAnalysis;
