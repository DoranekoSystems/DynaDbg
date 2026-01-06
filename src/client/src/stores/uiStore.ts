import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type Mode =
  | "home"
  | "server"
  | "debugger"
  | "information"
  | "scanner"
  | "network"
  | "logs"
  | "state"
  | "tools";

export interface DebuggerTabState {
  tabValue: number;
  activeFunction: string;
  selectedFunction?: { name: string; address: string };
  selectedModule: any;
  assemblyAddress: string;
  assemblyNavigationTrigger: number; // Counter to force re-navigation to same address
  assemblyNavigationHistory: string[]; // Stack of previous addresses for "Back" navigation
  memoryAddress: string;
  memoryCurrentAddress: string;
  memoryInputAddress: string;
  breakpointInputValue: string;
  gotoAddress: string;
  addressDisplayFormat: "library" | "function";
  assemblyDemangleEnabled: boolean;
  debuggerSettingsOpen: boolean; // Debugger settings dialog open state
  sourceCodeLevelDebug: boolean; // Source code level debugging enabled
  breakpointNotification: {
    open: boolean;
    message: string;
  };
}

export interface ScannerUIState {
  scanSettings: {
    valueType: string;
    scanType: string;
    value: string;
    startAddress?: string;
    endAddress?: string;
    scanMode: string;
    selectedRegions: string[];
    alignment: number;
    writable: boolean | null;
    executable: boolean | null;
    readable: boolean | null;
    doSuspend: boolean;
    valueInputFormat?: "dec" | "hex";
  };
  scanResults: any[];
  totalResults: number;
  isScanning: boolean;
  scanProgress: number;
  scannedBytes: number;
  totalBytes: number;
  currentRegion: string | null;
  scanId: string | null;
  unknownScanId?: string;
}

export interface InformationUIState {
  currentTab: number;
  nameFilter: string;
  sortField: string;
  sortDirection: "asc" | "desc";
  threads: ThreadInfo[];
  threadFilter: string;
  regions: RegionInfo[];
  regionFilter: string;
  regionProtectionFilter: {
    readable: boolean | null;
    writable: boolean | null;
    executable: boolean | null;
    private: boolean | null;
  };
  // Network connections
  networkConnections: NetworkConnectionInfo[];
  networkFilter: string;
  selectedModuleBase: number | null;
  symbols: SymbolInfoStore[];
  symbolFilter: string;
  symbolDemangleEnabled: boolean;
  symbolSortField: "name" | "address" | "size" | "type" | "scope";
  symbolSortDirection: "asc" | "desc";
  symbolTypeFilter: string;
  symbolScopeFilter: string;
  symbolColumnWidths: {
    name: number;
    address: number;
    size: number;
    type: number;
    scope: number;
    flags: number;
  };
  moduleColumnWidths: {
    name: number;
    base: number;
    size: number;
    arch: number;
    path: number;
  };
  regionColumnWidths: {
    start: number;
    end: number;
    size: number;
    protection: number;
    path: number;
  };
  threadColumnWidths: {
    id: number;
    name: number;
    address: number;
    detail: number;
    state: number;
  };
}

export interface SymbolInfoStore {
  name: string;
  address: string;
  size: number;
  type: string;
  scope?: string;
}

export interface ThreadInfo {
  thread_id: number;
  name: string;
  pc: string;
  sp: string;
  fp: string;
  state: string;
  suspend_count: number;
}

export interface RegionInfo {
  start_address: string;
  end_address: string;
  protection: string;
  file_path?: string;
}

export interface NetworkConnectionInfo {
  protocol: string;
  local_address: string;
  local_port: number;
  remote_address: string;
  remote_port: number;
  state: string;
  inode?: string;
}

export interface AssemblyViewCache {
  topVisibleAddress: string | null;
  timestamp: number;
}

export interface CachedSymbol {
  address: number;
  endAddress: number;
  name: string;
  moduleName: string;
  moduleBase: number;
}

export interface GlobalSymbolCache {
  symbols: CachedSymbol[];
  loadedModules: Set<number>;
  isLoading: boolean;
  loadingProgress: number;
}

export interface ToolsUIState {
  currentTab: number;
  objcClasses: any[];
  objcSelectedClass: any | null;
  objcSearchFilter: string;
  objcDetailTab: number;
  objcMethods: any[];
  objcIvars: any[];
  objcProperties: any[];
  objcProtocols: any[];
  ghidraPath: string;
  ghidraProjectName: string; // Project name for organizing analyzed libraries
  ghidraModuleFilter: string;
  ghidraModules: any[]; // ModuleInfo[] - persisted module list
  ghidraSelectedModuleBase: number | null;
  ghidraAnalysisLogs: Array<{
    timestamp: number;
    type: "info" | "error" | "success" | "output";
    message: string;
  }>;
  ghidraAnalysisProgress: string;
  ghidraIsAnalyzing: boolean;
  ghidraServerStatus: "stopped" | "starting" | "running" | "stopping";
  ghidraServerPort: number | null;
  ghidraServerProjectPath: string | null;
  scriptEditorContent: string;
  scriptShowLineNumbers: boolean;
  savedScripts: Array<{
    name: string;
    content: string;
    createdAt: number;
    description?: string;
  }>;
  selectedScriptIndex: number | null;
  openScriptTabs: Array<{
    id: string;
    name: string;
    content: string;
    isModified: boolean;
    savedScriptIndex: number | null;
  }>;
  activeScriptTabIndex: number;
  outputPanelHeight: number;
  scriptSidebarWidth: number;
  scriptCurrentJobId: string | null;
  scriptJobStatus:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | null;
  scriptLogs: Array<{
    timestamp: number;
    type: "info" | "error" | "success" | "output";
    message: string;
  }>;
  scriptFiles: Array<{
    filename: string;
    data_base64: string;
    mime_type?: string;
  }>;
  scriptDownloadedFiles: string[];
  fileExplorerCurrentPath: string;
  fileExplorerItems: FileExplorerItem[];
  fileExplorerExpandedPaths: string[];
  fileExplorerSelectedPath: string | null;
  fileExplorerViewerContent: FileViewerContent | null;
  fileExplorerIsLoading: boolean;
  debugState: DebugPanelState | null;
}

// Source breakpoint info
export interface SourceBreakpoint {
  filePath: string;
  line: number;
  address: number; // Absolute address (module base + offset)
  moduleBase: number;
  offset: number;
  enabled: boolean;
  isHit: boolean; // Currently stopped at this breakpoint
}

// Pending source jump request (from OUTLINE click)
export interface PendingSourceJump {
  filePath: string;
  line: number;
}

// DWARF Debug Panel state
export interface DebugPanelState {
  analysisResult: any | null; // DwarfAnalysisResult
  sourceCodeLevelDebug: boolean;
  selectedModuleBase: number | null;
  selectedModulePath: string | null; // Selected module path (for persistence)
  sourceRootPath: string; // Host OS path to source code root
  ndkPath: string; // Android NDK path (ANDROID_NDK_HOME)
  sourceBreakpoints: SourceBreakpoint[]; // Source-level breakpoints
  currentHitAddress: number | null; // Address where we're currently stopped
  pendingSourceJump: PendingSourceJump | null; // Jump to source line request
}

// File Explorer types
export interface FileExplorerItem {
  item_type: "file" | "directory";
  name: string;
  path: string;
  size?: number;
  last_opened?: number;
  children?: FileExplorerItem[];
}

export interface FileViewerContent {
  path: string;
  name: string;
  type: "text" | "binary" | "image" | "unknown";
  content: string | ArrayBuffer;
  size: number;
  mimeType?: string;
}

// Debugger Sidebar Cache (to prevent API calls on tab switch)
export interface DebuggerSidebarCache {
  modules: any[]; // ModuleInfo[]
  selectedModuleSymbols: any[]; // SymbolInfo[]
  ghidraFunctions: any[]; // GhidraFunctionEntry[]
  ghidraDataItems: any[]; // GhidraDataItem[]
  cachedProcessPid: number | null; // Track which process the cache is for
  cachedModulePath: string | null; // Track which module the symbols/functions are for
}

interface UIState {
  currentMode: Mode;

  sidebarWidth: number;
  debuggerSidebarWidth: number;
  scannerSidebarWidth: number;
  showRegisters: boolean;
  showToolbar: boolean;

  debuggerState: DebuggerTabState;

  scannerState: ScannerUIState;

  informationState: InformationUIState;

  toolsState: ToolsUIState;

  assemblyViewCache: AssemblyViewCache | null;

  globalSymbolCache: GlobalSymbolCache;

  debuggerSidebarCache: DebuggerSidebarCache;

  scanHistory: any[];
  bookmarks: any[];

  lastUpdate: number;
}

interface UIActions {
  setCurrentMode: (mode: Mode) => void;

  setSidebarWidth: (width: number) => void;
  setDebuggerSidebarWidth: (width: number) => void;
  setScannerSidebarWidth: (width: number) => void;
  setShowRegisters: (show: boolean) => void;
  setShowToolbar: (show: boolean) => void;

  setDebuggerTab: (tab: number) => void;
  setActiveFunction: (functionName: string) => void;
  setSelectedFunction: (
    functionInfo: { name: string; address: string } | undefined
  ) => void;
  setSelectedModule: (module: any) => void;
  setAssemblyAddress: (address: string) => void;
  setAssemblyAddressWithHistory: (address: string) => void; // Navigate with history tracking for Back button
  goBackAssemblyNavigation: () => void; // Go back to previous address
  clearAssemblyNavigationHistory: () => void; // Clear navigation history
  setMemoryAddress: (address: string) => void;
  setMemoryCurrentAddress: (address: string) => void;
  setMemoryInputAddress: (address: string) => void;
  setBreakpointInputValue: (value: string) => void;
  setGotoAddress: (address: string) => void;
  setAddressDisplayFormat: (format: "library" | "function") => void;
  toggleAddressDisplayFormat: () => void;
  setAssemblyDemangleEnabled: (enabled: boolean) => void;
  toggleAssemblyDemangle: () => void;
  setDebuggerSettingsOpen: (open: boolean) => void;
  setSourceCodeLevelDebug: (enabled: boolean) => void;
  toggleSourceCodeLevelDebug: () => void;
  showBreakpointNotification: (message: string) => void;
  hideBreakpointNotification: () => void;
  updateDebuggerState: (updates: Partial<DebuggerTabState>) => void;

  updateScannerState: (updates: Partial<ScannerUIState>) => void;
  setScanResults: (results: any[]) => void;
  clearScanResults: () => void;
  setScanSettings: (settings: any) => void;
  updateScanSettings: (updates: any) => void;

  setInformationTab: (tab: number) => void;
  setInformationNameFilter: (filter: string) => void;
  setInformationSort: (field: string, direction: "asc" | "desc") => void;
  updateInformationState: (updates: Partial<InformationUIState>) => void;
  setInformationThreads: (threads: ThreadInfo[]) => void;
  setInformationThreadFilter: (filter: string) => void;
  setInformationRegions: (regions: RegionInfo[]) => void;
  setInformationRegionFilter: (filter: string) => void;
  setRegionProtectionFilter: (filter: {
    readable: boolean | null;
    writable: boolean | null;
    executable: boolean | null;
    private: boolean | null;
  }) => void;
  setNetworkConnections: (connections: NetworkConnectionInfo[]) => void;
  setNetworkFilter: (filter: string) => void;
  setSymbolsSelectedModule: (moduleBase: number | null) => void;
  setSymbols: (symbols: SymbolInfoStore[]) => void;
  setSymbolFilter: (filter: string) => void;
  setSymbolDemangleEnabled: (enabled: boolean) => void;
  setSymbolSortField: (
    field: "name" | "address" | "size" | "type" | "scope"
  ) => void;
  setSymbolSortDirection: (direction: "asc" | "desc") => void;
  setSymbolTypeFilter: (filter: string) => void;
  setSymbolScopeFilter: (filter: string) => void;
  setSymbolColumnWidth: (
    column: keyof InformationUIState["symbolColumnWidths"],
    width: number
  ) => void;
  setModuleColumnWidth: (
    column: keyof InformationUIState["moduleColumnWidths"],
    width: number
  ) => void;
  setRegionColumnWidth: (
    column: keyof InformationUIState["regionColumnWidths"],
    width: number
  ) => void;
  setThreadColumnWidth: (
    column: keyof InformationUIState["threadColumnWidths"],
    width: number
  ) => void;

  setAssemblyViewCache: (cache: AssemblyViewCache | null) => void;
  clearAssemblyViewCache: () => void;

  addSymbolsToCache: (symbols: CachedSymbol[]) => void;
  markModuleAsLoaded: (moduleBase: number) => void;
  setSymbolCacheLoading: (isLoading: boolean, progress?: number) => void;
  clearSymbolCache: () => void;
  findSymbolForAddress: (address: number) => CachedSymbol | null;

  setScanHistory: (history: any[]) => void;
  addScanHistory: (item: any) => void;
  removeScanHistory: (index: number) => void;
  clearScanHistory: () => void;
  setBookmarks: (bookmarks: any[]) => void;
  addBookmark: (bookmark: any) => void;
  removeBookmark: (bookmarkId: string) => void;

  setToolsTab: (tab: number) => void;
  updateToolsState: (updates: Partial<ToolsUIState>) => void;
  setFileExplorerPath: (path: string) => void;
  setFileExplorerItems: (items: FileExplorerItem[]) => void;
  toggleFileExplorerExpanded: (path: string) => void;
  setFileExplorerSelectedPath: (path: string | null) => void;
  setFileExplorerViewerContent: (content: FileViewerContent | null) => void;
  setFileExplorerIsLoading: (loading: boolean) => void;

  // Source-level breakpoint actions
  addSourceBreakpoint: (breakpoint: SourceBreakpoint) => void;
  removeSourceBreakpoint: (filePath: string, line: number) => void;
  toggleSourceBreakpoint: (filePath: string, line: number) => void;
  setCurrentHitAddress: (address: number | null) => void;
  clearSourceBreakpoints: () => void;
  setPendingSourceJump: (jump: PendingSourceJump | null) => void;

  // Debugger Sidebar Cache
  setDebuggerSidebarModules: (modules: any[], processPid: number) => void;
  setDebuggerSidebarSymbols: (symbols: any[], modulePath: string) => void;
  setDebuggerSidebarGhidraFunctions: (
    functions: any[],
    modulePath: string
  ) => void;
  setDebuggerSidebarGhidraData: (dataItems: any[], modulePath: string) => void;
  clearDebuggerSidebarCache: () => void;

  touch: () => void;
}

const initialState: UIState = {
  currentMode: "home",
  sidebarWidth: 240,
  debuggerSidebarWidth: 280,
  scannerSidebarWidth: 280,
  showRegisters: false,
  showToolbar: true,

  debuggerState: {
    tabValue: 0,
    activeFunction: "",
    selectedFunction: undefined,
    selectedModule: null,
    assemblyAddress: "",
    assemblyNavigationTrigger: 0,
    assemblyNavigationHistory: [],
    memoryAddress: "",
    memoryCurrentAddress: "",
    memoryInputAddress: "",
    breakpointInputValue: "",
    gotoAddress: "",
    addressDisplayFormat: "function" as const,
    assemblyDemangleEnabled: true,
    debuggerSettingsOpen: false,
    sourceCodeLevelDebug: false,
    breakpointNotification: {
      open: false,
      message: "",
    },
  },

  scannerState: {
    scanSettings: {
      valueType: "int32",
      scanType: "exact",
      value: "",
      startAddress: "",
      endAddress: "",
      scanMode: "manual",
      selectedRegions: [],
      alignment: 4,
      writable: null,
      executable: null,
      readable: null,
      doSuspend: false,
      valueInputFormat: "dec" as "dec" | "hex",
    },
    scanResults: [],
    totalResults: 0,
    isScanning: false,
    scanProgress: 0,
    scannedBytes: 0,
    totalBytes: 0,
    currentRegion: null,
    scanId: null,
  },

  informationState: {
    currentTab: 0,
    nameFilter: "",
    sortField: "name",
    sortDirection: "asc",
    threads: [],
    threadFilter: "",
    regions: [],
    regionFilter: "",
    regionProtectionFilter: {
      readable: null,
      writable: null,
      executable: null,
      private: null,
    },
    networkConnections: [],
    networkFilter: "",
    selectedModuleBase: null,
    symbols: [],
    symbolFilter: "",
    symbolDemangleEnabled: true,
    symbolSortField: "address",
    symbolSortDirection: "asc",
    symbolTypeFilter: "all",
    symbolScopeFilter: "all",
    symbolColumnWidths: {
      name: 300,
      address: 140,
      size: 80,
      type: 100,
      scope: 80,
      flags: 150,
    },
    moduleColumnWidths: {
      name: 240,
      base: 140,
      size: 70,
      arch: 80,
      path: 200,
    },
    regionColumnWidths: {
      start: 180,
      end: 180,
      size: 90,
      protection: 90,
      path: 200,
    },
    threadColumnWidths: {
      id: 100,
      name: 200,
      address: 140,
      detail: 200,
      state: 100,
    },
  },

  toolsState: {
    currentTab: 0,
    objcClasses: [],
    objcSelectedClass: null,
    objcSearchFilter: "",
    objcDetailTab: 0,
    objcMethods: [],
    objcIvars: [],
    objcProperties: [],
    objcProtocols: [],
    ghidraPath: localStorage.getItem("dynadbg_ghidra_path") || "",
    ghidraProjectName:
      localStorage.getItem("dynadbg_ghidra_project_name") || "",
    ghidraModuleFilter: "",
    ghidraModules: [],
    ghidraSelectedModuleBase: null,
    ghidraAnalysisLogs: [],
    ghidraAnalysisProgress: "",
    ghidraIsAnalyzing: false,
    ghidraServerStatus: "stopped",
    ghidraServerPort: null,
    ghidraServerProjectPath: null,
    scriptEditorContent: "",
    scriptShowLineNumbers: true,
    savedScripts: [],
    selectedScriptIndex: null,
    openScriptTabs: [],
    activeScriptTabIndex: 0,
    outputPanelHeight: 150,
    scriptSidebarWidth: 200,
    scriptCurrentJobId: null,
    scriptJobStatus: null,
    scriptLogs: [],
    scriptFiles: [],
    scriptDownloadedFiles: [],
    fileExplorerCurrentPath: "/",
    fileExplorerItems: [],
    fileExplorerExpandedPaths: [],
    fileExplorerSelectedPath: null,
    fileExplorerViewerContent: null,
    fileExplorerIsLoading: false,
    debugState: (() => {
      try {
        const saved = localStorage.getItem("dynadbg_dwarf_settings");
        if (saved) {
          const parsed = JSON.parse(saved);
          return {
            analysisResult: null, // Don't persist analysis results
            sourceCodeLevelDebug: parsed.sourceCodeLevelDebug || false,
            selectedModuleBase: null, // Don't persist, will be set on module select
            selectedModulePath: parsed.selectedModulePath || null,
            sourceRootPath: parsed.sourceRootPath || "",
            ndkPath: parsed.ndkPath || "",
            sourceBreakpoints: [], // Don't persist breakpoints
            currentHitAddress: null,
            pendingSourceJump: null,
          };
        }
      } catch (e) {
        console.error("Failed to load DWARF settings from localStorage:", e);
      }
      return null;
    })(),
  },

  assemblyViewCache: null,

  globalSymbolCache: {
    symbols: [],
    loadedModules: new Set<number>(),
    isLoading: false,
    loadingProgress: 0,
  },

  debuggerSidebarCache: {
    modules: [],
    selectedModuleSymbols: [],
    ghidraFunctions: [],
    ghidraDataItems: [],
    cachedProcessPid: null,
    cachedModulePath: null,
  },

  scanHistory: [],
  bookmarks: [],
  lastUpdate: Date.now(),
};

export const useUIStore = create<UIState & { actions: UIActions }>()(
  devtools(
    (set): UIState & { actions: UIActions } => ({
      ...initialState,

      actions: {
        setCurrentMode: (mode) =>
          set(() => ({
            currentMode: mode,
            lastUpdate: Date.now(),
          })),

        setSidebarWidth: (width) =>
          set(() => ({
            sidebarWidth: width,
            lastUpdate: Date.now(),
          })),

        setDebuggerSidebarWidth: (width) =>
          set(() => ({
            debuggerSidebarWidth: width,
            lastUpdate: Date.now(),
          })),

        setScannerSidebarWidth: (width) =>
          set(() => ({
            scannerSidebarWidth: width,
            lastUpdate: Date.now(),
          })),

        setShowRegisters: (show) =>
          set(() => ({
            showRegisters: show,
            lastUpdate: Date.now(),
          })),

        setShowToolbar: (show) =>
          set(() => ({
            showToolbar: show,
            lastUpdate: Date.now(),
          })),

        setDebuggerTab: (tab) =>
          set((state) => {
            const newDebuggerState = { ...state.debuggerState, tabValue: tab };
            try {
              localStorage.setItem(
                "debugger-ui-state",
                JSON.stringify(newDebuggerState)
              );
            } catch (error) {
              console.error(
                "Failed to save debugger UI state to localStorage:",
                error
              );
            }
            return {
              debuggerState: newDebuggerState,
              lastUpdate: Date.now(),
            };
          }),

        setActiveFunction: (functionName) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              activeFunction: functionName,
            },
            lastUpdate: Date.now(),
          })),

        setSelectedFunction: (functionInfo) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              selectedFunction: functionInfo,
            },
            lastUpdate: Date.now(),
          })),

        setSelectedModule: (module) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              selectedModule: module,
            },
            lastUpdate: Date.now(),
          })),

        setAssemblyAddress: (address) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              assemblyAddress: address,
              assemblyNavigationTrigger:
                state.debuggerState.assemblyNavigationTrigger + 1,
            },
            lastUpdate: Date.now(),
          })),

        // Navigate to address with history tracking for Back button
        setAssemblyAddressWithHistory: (address) =>
          set((state) => {
            const currentAddress = state.debuggerState.assemblyAddress;
            const newHistory = currentAddress
              ? [
                  ...state.debuggerState.assemblyNavigationHistory,
                  currentAddress,
                ].slice(-50) // Keep last 50 entries
              : state.debuggerState.assemblyNavigationHistory;
            return {
              debuggerState: {
                ...state.debuggerState,
                assemblyAddress: address,
                assemblyNavigationTrigger:
                  state.debuggerState.assemblyNavigationTrigger + 1,
                assemblyNavigationHistory: newHistory,
              },
              lastUpdate: Date.now(),
            };
          }),

        // Go back to previous address
        goBackAssemblyNavigation: () =>
          set((state) => {
            const history = state.debuggerState.assemblyNavigationHistory;
            if (history.length === 0) return state;
            const previousAddress = history[history.length - 1];
            const newHistory = history.slice(0, -1);
            return {
              debuggerState: {
                ...state.debuggerState,
                assemblyAddress: previousAddress,
                assemblyNavigationTrigger:
                  state.debuggerState.assemblyNavigationTrigger + 1,
                assemblyNavigationHistory: newHistory,
              },
              lastUpdate: Date.now(),
            };
          }),

        // Clear navigation history
        clearAssemblyNavigationHistory: () =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              assemblyNavigationHistory: [],
            },
            lastUpdate: Date.now(),
          })),

        setMemoryCurrentAddress: (address) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              memoryCurrentAddress: address,
            },
            lastUpdate: Date.now(),
          })),

        setMemoryInputAddress: (address) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              memoryInputAddress: address,
            },
            lastUpdate: Date.now(),
          })),

        setMemoryAddress: (address) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              memoryAddress: address,
            },
            lastUpdate: Date.now(),
          })),

        setBreakpointInputValue: (value) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              breakpointInputValue: value,
            },
            lastUpdate: Date.now(),
          })),

        setGotoAddress: (address) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              gotoAddress: address,
            },
            lastUpdate: Date.now(),
          })),

        setAddressDisplayFormat: (format) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              addressDisplayFormat: format,
            },
            lastUpdate: Date.now(),
          })),

        toggleAddressDisplayFormat: () =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              addressDisplayFormat:
                state.debuggerState.addressDisplayFormat === "library"
                  ? "function"
                  : "library",
            },
            lastUpdate: Date.now(),
          })),

        setAssemblyDemangleEnabled: (enabled) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              assemblyDemangleEnabled: enabled,
            },
            lastUpdate: Date.now(),
          })),

        toggleAssemblyDemangle: () =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              assemblyDemangleEnabled:
                !state.debuggerState.assemblyDemangleEnabled,
            },
            lastUpdate: Date.now(),
          })),

        setDebuggerSettingsOpen: (open) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              debuggerSettingsOpen: open,
            },
            lastUpdate: Date.now(),
          })),

        setSourceCodeLevelDebug: (enabled) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              sourceCodeLevelDebug: enabled,
            },
            lastUpdate: Date.now(),
          })),

        toggleSourceCodeLevelDebug: () =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              sourceCodeLevelDebug: !state.debuggerState.sourceCodeLevelDebug,
            },
            lastUpdate: Date.now(),
          })),

        showBreakpointNotification: (message) =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              breakpointNotification: { open: true, message },
            },
            lastUpdate: Date.now(),
          })),

        hideBreakpointNotification: () =>
          set((state) => ({
            debuggerState: {
              ...state.debuggerState,
              breakpointNotification: {
                ...state.debuggerState.breakpointNotification,
                open: false,
              },
            },
            lastUpdate: Date.now(),
          })),

        updateDebuggerState: (updates) =>
          set((state) => {
            const newDebuggerState = { ...state.debuggerState, ...updates };
            try {
              localStorage.setItem(
                "debugger-ui-state",
                JSON.stringify(newDebuggerState)
              );
            } catch (error) {
              console.error(
                "Failed to save debugger UI state to localStorage:",
                error
              );
            }
            return {
              debuggerState: newDebuggerState,
              lastUpdate: Date.now(),
            };
          }),

        updateScannerState: (updates) =>
          set((state) => ({
            scannerState: { ...state.scannerState, ...updates },
            lastUpdate: Date.now(),
          })),

        setScanResults: (results) =>
          set((state) => ({
            scannerState: { ...state.scannerState, scanResults: results },
            lastUpdate: Date.now(),
          })),

        clearScanResults: () =>
          set((state) => ({
            scannerState: {
              ...state.scannerState,
              scanResults: [],
              totalResults: 0,
            },
            lastUpdate: Date.now(),
          })),

        setScanSettings: (settings) =>
          set((state) => {
            try {
              localStorage.setItem(
                "scanner-ui-settings",
                JSON.stringify(settings)
              );
            } catch (error) {
              console.error(
                "Failed to save scan UI settings to localStorage:",
                error
              );
            }
            return {
              scannerState: { ...state.scannerState, scanSettings: settings },
              lastUpdate: Date.now(),
            };
          }),

        updateScanSettings: (updates) =>
          set((state) => {
            const newSettings = {
              ...state.scannerState.scanSettings,
              ...updates,
            };
            try {
              localStorage.setItem(
                "scanner-ui-settings",
                JSON.stringify(newSettings)
              );
            } catch (error) {
              console.error(
                "Failed to save scan UI settings to localStorage:",
                error
              );
            }
            return {
              scannerState: {
                ...state.scannerState,
                scanSettings: newSettings,
              },
              lastUpdate: Date.now(),
            };
          }),

        setInformationTab: (tab) =>
          set((state) => {
            const newInformationState = {
              ...state.informationState,
              currentTab: tab,
            };
            try {
              localStorage.setItem(
                "information-ui-state",
                JSON.stringify(newInformationState)
              );
            } catch (error) {
              console.error(
                "Failed to save information UI state to localStorage:",
                error
              );
            }
            return {
              informationState: newInformationState,
              lastUpdate: Date.now(),
            };
          }),

        setInformationNameFilter: (filter) =>
          set((state) => {
            const newInformationState = {
              ...state.informationState,
              nameFilter: filter,
            };
            try {
              localStorage.setItem(
                "information-ui-state",
                JSON.stringify(newInformationState)
              );
            } catch (error) {
              console.error(
                "Failed to save information UI state to localStorage:",
                error
              );
            }
            return {
              informationState: newInformationState,
              lastUpdate: Date.now(),
            };
          }),

        setInformationSort: (field, direction) =>
          set((state) => {
            const newInformationState = {
              ...state.informationState,
              sortField: field,
              sortDirection: direction,
            };
            try {
              localStorage.setItem(
                "information-ui-state",
                JSON.stringify(newInformationState)
              );
            } catch (error) {
              console.error(
                "Failed to save information UI state to localStorage:",
                error
              );
            }
            return {
              informationState: newInformationState,
              lastUpdate: Date.now(),
            };
          }),

        updateInformationState: (updates) =>
          set((state) => {
            const newInformationState = {
              ...state.informationState,
              ...updates,
            };
            try {
              localStorage.setItem(
                "information-ui-state",
                JSON.stringify(newInformationState)
              );
            } catch (error) {
              console.error(
                "Failed to save information UI state to localStorage:",
                error
              );
            }
            return {
              informationState: newInformationState,
              lastUpdate: Date.now(),
            };
          }),

        setInformationThreads: (threads) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              threads,
            },
            lastUpdate: Date.now(),
          })),

        setInformationThreadFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              threadFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setInformationRegions: (regions) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              regions,
            },
            lastUpdate: Date.now(),
          })),

        setInformationRegionFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              regionFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setRegionProtectionFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              regionProtectionFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setNetworkConnections: (connections) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              networkConnections: connections,
            },
            lastUpdate: Date.now(),
          })),

        setNetworkFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              networkFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolsSelectedModule: (moduleBase) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              selectedModuleBase: moduleBase,
            },
            lastUpdate: Date.now(),
          })),

        setSymbols: (symbols) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbols,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolDemangleEnabled: (enabled) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolDemangleEnabled: enabled,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolSortField: (field) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolSortField: field,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolSortDirection: (direction) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolSortDirection: direction,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolTypeFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolTypeFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolScopeFilter: (filter) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolScopeFilter: filter,
            },
            lastUpdate: Date.now(),
          })),

        setSymbolColumnWidth: (column, width) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              symbolColumnWidths: {
                ...state.informationState.symbolColumnWidths,
                [column]: width,
              },
            },
            lastUpdate: Date.now(),
          })),

        setModuleColumnWidth: (column, width) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              moduleColumnWidths: {
                ...state.informationState.moduleColumnWidths,
                [column]: width,
              },
            },
            lastUpdate: Date.now(),
          })),

        setRegionColumnWidth: (column, width) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              regionColumnWidths: {
                ...state.informationState.regionColumnWidths,
                [column]: width,
              },
            },
            lastUpdate: Date.now(),
          })),

        setThreadColumnWidth: (column, width) =>
          set((state) => ({
            informationState: {
              ...state.informationState,
              threadColumnWidths: {
                ...state.informationState.threadColumnWidths,
                [column]: width,
              },
            },
            lastUpdate: Date.now(),
          })),

        setAssemblyViewCache: (cache) =>
          set(() => {
            console.log("[UI STORE] Setting assembly view cache:", cache);
            return {
              assemblyViewCache: cache,
              lastUpdate: Date.now(),
            };
          }),

        clearAssemblyViewCache: () =>
          set(() => {
            console.log("[UI STORE] Clearing assembly view cache");
            return {
              assemblyViewCache: null,
              lastUpdate: Date.now(),
            };
          }),

        addSymbolsToCache: (symbols) =>
          set((state) => {
            const existingSymbols = state.globalSymbolCache.symbols;

            const sortedNewSymbols = [...symbols].sort(
              (a, b) => a.address - b.address
            );

            if (existingSymbols.length === 0) {
              return {
                globalSymbolCache: {
                  ...state.globalSymbolCache,
                  symbols: sortedNewSymbols,
                },
                lastUpdate: Date.now(),
              };
            }

            const mergedSymbols: typeof existingSymbols = [];
            let i = 0,
              j = 0;
            while (i < existingSymbols.length && j < sortedNewSymbols.length) {
              if (existingSymbols[i].address <= sortedNewSymbols[j].address) {
                mergedSymbols.push(existingSymbols[i]);
                i++;
              } else {
                mergedSymbols.push(sortedNewSymbols[j]);
                j++;
              }
            }
            while (i < existingSymbols.length) {
              mergedSymbols.push(existingSymbols[i]);
              i++;
            }
            while (j < sortedNewSymbols.length) {
              mergedSymbols.push(sortedNewSymbols[j]);
              j++;
            }

            return {
              globalSymbolCache: {
                ...state.globalSymbolCache,
                symbols: mergedSymbols,
              },
              lastUpdate: Date.now(),
            };
          }),

        markModuleAsLoaded: (moduleBase) =>
          set((state) => {
            const newLoadedModules = new Set(
              state.globalSymbolCache.loadedModules
            );
            newLoadedModules.add(moduleBase);
            return {
              globalSymbolCache: {
                ...state.globalSymbolCache,
                loadedModules: newLoadedModules,
              },
              lastUpdate: Date.now(),
            };
          }),

        setSymbolCacheLoading: (isLoading, progress = 0) =>
          set((state) => ({
            globalSymbolCache: {
              ...state.globalSymbolCache,
              isLoading,
              loadingProgress: progress,
            },
            lastUpdate: Date.now(),
          })),

        clearSymbolCache: () =>
          set(() => ({
            globalSymbolCache: {
              symbols: [],
              loadedModules: new Set<number>(),
              isLoading: false,
              loadingProgress: 0,
            },
            lastUpdate: Date.now(),
          })),

        findSymbolForAddress: (address) => {
          const state = useUIStore.getState();
          const symbols = state.globalSymbolCache.symbols;

          if (symbols.length === 0) return null;

          let left = 0;
          let right = symbols.length - 1;

          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const symbol = symbols[mid];

            if (address >= symbol.address && address < symbol.endAddress) {
              return symbol;
            } else if (address < symbol.address) {
              right = mid - 1;
            } else {
              left = mid + 1;
            }
          }

          return null;
        },

        setScanHistory: (history: any[]) =>
          set(() => ({
            scanHistory: history,
            lastUpdate: Date.now(),
          })),

        addScanHistory: (item: any) =>
          set((state) => {
            const existingIndex = state.scanHistory.findIndex(
              (existing) =>
                existing.valueType === item.valueType &&
                existing.scanType === item.scanType &&
                existing.value === item.value
            );

            let newHistory: any[];
            if (existingIndex !== -1) {
              newHistory = [
                item,
                ...state.scanHistory.filter((_, i) => i !== existingIndex),
              ];
            } else {
              newHistory = [item, ...state.scanHistory];
            }

            if (newHistory.length > 100) {
              newHistory = newHistory.slice(0, 100);
            }

            try {
              localStorage.setItem("scan-history", JSON.stringify(newHistory));
            } catch (error) {
              console.error(
                "Failed to save scan history to localStorage:",
                error
              );
            }

            return {
              scanHistory: newHistory,
              lastUpdate: Date.now(),
            };
          }),

        removeScanHistory: (index: number) =>
          set((state) => {
            const newHistory = state.scanHistory.filter((_, i) => i !== index);
            try {
              localStorage.setItem("scan-history", JSON.stringify(newHistory));
            } catch (error) {
              console.error(
                "Failed to save scan history to localStorage:",
                error
              );
            }
            return {
              scanHistory: newHistory,
              lastUpdate: Date.now(),
            };
          }),

        clearScanHistory: () =>
          set(() => {
            try {
              localStorage.removeItem("scan-history");
            } catch (error) {
              console.error(
                "Failed to clear scan history from localStorage:",
                error
              );
            }
            return {
              scanHistory: [],
              lastUpdate: Date.now(),
            };
          }),

        setBookmarks: (bookmarks: any[]) =>
          set(() => ({
            bookmarks: bookmarks,
            lastUpdate: Date.now(),
          })),

        addBookmark: (bookmark: any) =>
          set((state) => {
            const exists = state.bookmarks.some(
              (b) => b.address === bookmark.address
            );
            if (exists) {
              return state;
            }

            const newBookmarks = [...state.bookmarks, bookmark];
            try {
              localStorage.setItem("bookmarks", JSON.stringify(newBookmarks));
            } catch (error) {
              console.error("Failed to save bookmarks to localStorage:", error);
            }
            return {
              bookmarks: newBookmarks,
              lastUpdate: Date.now(),
            };
          }),

        removeBookmark: (bookmarkId: string) =>
          set((state) => {
            const newBookmarks = state.bookmarks.filter(
              (b) => b.id !== bookmarkId
            );
            try {
              localStorage.setItem("bookmarks", JSON.stringify(newBookmarks));
            } catch (error) {
              console.error("Failed to save bookmarks to localStorage:", error);
            }
            return {
              bookmarks: newBookmarks,
              lastUpdate: Date.now(),
            };
          }),

        setToolsTab: (tab: number) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              currentTab: tab,
            },
            lastUpdate: Date.now(),
          })),

        updateToolsState: (updates: Partial<ToolsUIState>) =>
          set((state) => {
            const newToolsState = {
              ...state.toolsState,
              ...updates,
            };

            // Persist DWARF settings to localStorage if debugState was updated
            if (updates.debugState) {
              try {
                const settingsToSave = {
                  sourceCodeLevelDebug:
                    updates.debugState.sourceCodeLevelDebug || false,
                  selectedModulePath:
                    updates.debugState.selectedModulePath || null,
                  sourceRootPath: updates.debugState.sourceRootPath || "",
                  ndkPath: updates.debugState.ndkPath || "",
                };
                localStorage.setItem(
                  "dynadbg_dwarf_settings",
                  JSON.stringify(settingsToSave)
                );
              } catch (e) {
                console.error(
                  "Failed to save DWARF settings to localStorage:",
                  e
                );
              }
            }

            return {
              toolsState: newToolsState,
              lastUpdate: Date.now(),
            };
          }),

        setFileExplorerPath: (path: string) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              fileExplorerCurrentPath: path,
            },
            lastUpdate: Date.now(),
          })),

        setFileExplorerItems: (items: FileExplorerItem[]) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              fileExplorerItems: items,
            },
            lastUpdate: Date.now(),
          })),

        toggleFileExplorerExpanded: (path: string) =>
          set((state) => {
            const expanded = state.toolsState.fileExplorerExpandedPaths;
            const isExpanded = expanded.includes(path);
            return {
              toolsState: {
                ...state.toolsState,
                fileExplorerExpandedPaths: isExpanded
                  ? expanded.filter((p) => p !== path)
                  : [...expanded, path],
              },
              lastUpdate: Date.now(),
            };
          }),

        setFileExplorerSelectedPath: (path: string | null) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              fileExplorerSelectedPath: path,
            },
            lastUpdate: Date.now(),
          })),

        setFileExplorerViewerContent: (content: FileViewerContent | null) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              fileExplorerViewerContent: content,
            },
            lastUpdate: Date.now(),
          })),

        setFileExplorerIsLoading: (loading: boolean) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              fileExplorerIsLoading: loading,
            },
            lastUpdate: Date.now(),
          })),

        // Source-level breakpoint actions
        addSourceBreakpoint: (breakpoint: SourceBreakpoint) =>
          set((state) => {
            const currentBreakpoints =
              state.toolsState.debugState?.sourceBreakpoints || [];
            // Check if already exists
            const exists = currentBreakpoints.some(
              (bp) =>
                bp.filePath === breakpoint.filePath &&
                bp.line === breakpoint.line
            );
            if (exists) return state;
            return {
              toolsState: {
                ...state.toolsState,
                debugState: state.toolsState.debugState
                  ? {
                      ...state.toolsState.debugState,
                      sourceBreakpoints: [...currentBreakpoints, breakpoint],
                    }
                  : null,
              },
              lastUpdate: Date.now(),
            };
          }),

        removeSourceBreakpoint: (filePath: string, line: number) =>
          set((state) => {
            const currentBreakpoints =
              state.toolsState.debugState?.sourceBreakpoints || [];
            return {
              toolsState: {
                ...state.toolsState,
                debugState: state.toolsState.debugState
                  ? {
                      ...state.toolsState.debugState,
                      sourceBreakpoints: currentBreakpoints.filter(
                        (bp) => !(bp.filePath === filePath && bp.line === line)
                      ),
                    }
                  : null,
              },
              lastUpdate: Date.now(),
            };
          }),

        toggleSourceBreakpoint: (filePath: string, line: number) =>
          set((state) => {
            const currentBreakpoints =
              state.toolsState.debugState?.sourceBreakpoints || [];
            const existingIndex = currentBreakpoints.findIndex(
              (bp) => bp.filePath === filePath && bp.line === line
            );
            if (existingIndex >= 0) {
              // Toggle enabled state
              const updated = [...currentBreakpoints];
              updated[existingIndex] = {
                ...updated[existingIndex],
                enabled: !updated[existingIndex].enabled,
              };
              return {
                toolsState: {
                  ...state.toolsState,
                  debugState: state.toolsState.debugState
                    ? {
                        ...state.toolsState.debugState,
                        sourceBreakpoints: updated,
                      }
                    : null,
                },
                lastUpdate: Date.now(),
              };
            }
            return state;
          }),

        setCurrentHitAddress: (address: number | null) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              debugState: state.toolsState.debugState
                ? {
                    ...state.toolsState.debugState,
                    currentHitAddress: address,
                  }
                : null,
            },
            lastUpdate: Date.now(),
          })),

        clearSourceBreakpoints: () =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              debugState: state.toolsState.debugState
                ? {
                    ...state.toolsState.debugState,
                    sourceBreakpoints: [],
                    currentHitAddress: null,
                  }
                : null,
            },
            lastUpdate: Date.now(),
          })),

        setPendingSourceJump: (jump: PendingSourceJump | null) =>
          set((state) => ({
            toolsState: {
              ...state.toolsState,
              debugState: state.toolsState.debugState
                ? {
                    ...state.toolsState.debugState,
                    pendingSourceJump: jump,
                  }
                : null,
            },
            lastUpdate: Date.now(),
          })),

        // Debugger Sidebar Cache
        setDebuggerSidebarModules: (modules: any[], processPid: number) =>
          set((state) => ({
            debuggerSidebarCache: {
              ...state.debuggerSidebarCache,
              modules,
              cachedProcessPid: processPid,
            },
            lastUpdate: Date.now(),
          })),

        setDebuggerSidebarSymbols: (symbols: any[], modulePath: string) =>
          set((state) => ({
            debuggerSidebarCache: {
              ...state.debuggerSidebarCache,
              selectedModuleSymbols: symbols,
              cachedModulePath: modulePath,
            },
            lastUpdate: Date.now(),
          })),

        setDebuggerSidebarGhidraFunctions: (
          functions: any[],
          modulePath: string
        ) =>
          set((state) => ({
            debuggerSidebarCache: {
              ...state.debuggerSidebarCache,
              ghidraFunctions: functions,
              cachedModulePath: modulePath,
            },
            lastUpdate: Date.now(),
          })),

        setDebuggerSidebarGhidraData: (dataItems: any[], modulePath: string) =>
          set((state) => ({
            debuggerSidebarCache: {
              ...state.debuggerSidebarCache,
              ghidraDataItems: dataItems,
              cachedModulePath: modulePath,
            },
            lastUpdate: Date.now(),
          })),

        clearDebuggerSidebarCache: () =>
          set(() => ({
            debuggerSidebarCache: {
              modules: [],
              selectedModuleSymbols: [],
              ghidraFunctions: [],
              ghidraDataItems: [],
              cachedProcessPid: null,
              cachedModulePath: null,
            },
            lastUpdate: Date.now(),
          })),

        touch: () =>
          set(() => ({
            lastUpdate: Date.now(),
          })),
      },
    }),
    {
      name: "ui-store",
    }
  )
);

export const useCurrentMode = () => useUIStore((state) => state.currentMode);
export const useSidebarWidth = () => useUIStore((state) => state.sidebarWidth);
export const useShowRegisters = () =>
  useUIStore((state) => state.showRegisters);
export const useShowToolbar = () => useUIStore((state) => state.showToolbar);

export const useDebuggerTab = () =>
  useUIStore((state) => state.debuggerState.tabValue);
export const useActiveFunction = () =>
  useUIStore((state) => state.debuggerState.activeFunction);
export const useSelectedFunction = () =>
  useUIStore((state) => state.debuggerState.selectedFunction);
export const useSelectedModule = () =>
  useUIStore((state) => state.debuggerState.selectedModule);
export const useAssemblyAddress = () =>
  useUIStore((state) => state.debuggerState.assemblyAddress);
export const useMemoryAddress = () =>
  useUIStore((state) => state.debuggerState.memoryAddress);
export const useBreakpointNotification = () =>
  useUIStore((state) => state.debuggerState.breakpointNotification);
export const useBreakpointInputValue = () =>
  useUIStore((state) => state.debuggerState.breakpointInputValue);

export const useScannerState = () => useUIStore((state) => state.scannerState);
export const useScanResults = () =>
  useUIStore((state) => state.scannerState.scanResults);
export const useScanSettings = () =>
  useUIStore((state) => state.scannerState.scanSettings);

export const useInformationState = () =>
  useUIStore((state) => state.informationState);

export const useScanHistory = () => useUIStore((state) => state.scanHistory);
export const useBookmarks = () => useUIStore((state) => state.bookmarks);

export const useUIActions = () => useUIStore((state) => state.actions);

export const useUIUpdate = () => useUIStore((state) => state.lastUpdate);
