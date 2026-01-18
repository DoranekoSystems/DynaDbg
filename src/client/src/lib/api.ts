// API client for communicating with the backend server
import { invoke } from "@tauri-apps/api/core";
import {
  FilterRequest,
  FilterResponse,
  FilterProgressResponse,
  ExceptionInfo,
} from "../types/index";

// Native memory filter types (for Tauri commands)
export interface NativeMemoryFilterRequest {
  addresses: number[]; // List of addresses to filter
  old_values: number[][]; // Previous values at those addresses (as byte arrays)
  pattern: string; // Hex-encoded pattern for comparison (min for range)
  pattern_max?: string; // Hex-encoded max pattern for range filter
  data_type: string; // "int8", "uint8", "int16", etc.
  filter_method: string; // "exact", "range", "greater_or_equal", "less_than", "changed", "unchanged", "increased", "decreased"
}

export interface NativeMemoryFilterResult {
  address: number;
  value: number[]; // New value at the address as byte array
}

export interface NativeMemoryFilterResponse {
  success: boolean;
  results: NativeMemoryFilterResult[];
  total_processed: number;
  error?: string;
}

// Native unknown scan types (for Tauri commands)
// Unknown Scan Streaming API types (server-side)
export interface UnknownScanStartRequest {
  scan_id: string;
  address_ranges: [number, number][]; // [(start, end), ...]
  data_type: string; // "int8", "uint8", "int16", etc.
  alignment: number;
  do_suspend: boolean;
}

export interface UnknownScanStartResponse {
  success: boolean;
  scan_id: string;
  total_bytes: number;
  message?: string;
  error?: string;
}

export interface UnknownScanChunk {
  start_address: number;
  uncompressed_size: number;
  compressed_data: number[]; // LZ4 compressed bytes
}

export interface UnknownScanStreamResponse {
  success: boolean;
  scan_id: string;
  progress_percentage: number;
  processed_bytes: number;
  total_bytes: number;
  is_scanning: boolean;
  chunks: UnknownScanChunk[];
  message?: string;
}

// Legacy Tauri-based unknown scan types (for backward compatibility)
export interface NativeUnknownScanRequest {
  address_ranges: [number, number][]; // [(start, end), ...]
  data_type: string; // "int8", "uint8", "int16", etc.
  alignment: number; // Alignment for scanning
  scan_id: string; // Unique scan ID for temp file storage
}

export interface NativeUnknownScanResponse {
  success: boolean;
  scan_id: string;
  total_addresses: number;
  temp_dir: string;
  error?: string;
}

export interface NativeUnknownScanProgress {
  scan_id: string;
  progress_percentage: number;
  processed_bytes: number;
  total_bytes: number;
  found_count: number;
  is_scanning: boolean;
  current_region?: string;
}

export interface NativeUnknownScanLookupResponse {
  success: boolean;
  results: NativeMemoryFilterResult[];
  total_count: number;
  error?: string;
}

// Network logging types
export interface NetworkRequestCapture {
  method: string;
  url: string;
  endpoint: string;
  requestHeaders?: Record<string, string>;
  requestBody?: any;
  requestSize?: number;
}

export interface NetworkResponseCapture {
  status: number;
  responseHeaders?: Record<string, string>;
  responseBody?: any;
  responseSize?: number;
  duration: number;
  error?: string;
}

export interface ServerInfo {
  git_hash: string;
  arch: string;
  pid: number;
  mode: string;
  target_os: string;
  build_timestamp?: number;
}

export interface DisassembleRequest {
  address: number;
  size: number;
  architecture: string;
}

export interface DisassembleResponse {
  success: boolean;
  disassembly?: string;
  instructions_count: number;
  error?: string;
}

export interface MemoryReadRequest {
  address: number;
  size: number;
}

export interface MemoryReadResponse {
  success: boolean;
  data?: number[] | Uint8Array;
  error?: string;
}

export interface NewsItem {
  id: string;
  date: string;
  title: string;
  body: string;
  type: "update" | "info" | "warning" | "announcement";
  link: string;
}

export interface NewsResponse {
  latest_version: string;
  force_update: boolean;
  news: NewsItem[];
}

export interface WatchpointInfo {
  id: string;
  address: number;
  size: number;
  access_type: string; // "r", "w", "rw", "x", "rx", "wx", "rwx"
  hit_count: number;
  created_at: string; // ISO 8601 timestamp
  description?: string;
}

export interface ConnectionState {
  connected: boolean;
  host: string;
  port: number;
  serverInfo?: ServerInfo;
  lastError?: string;
}

export interface ProcessState {
  attached: boolean;
  pid?: number;
  name?: string;
  processInfo?: ProcessInfo;
  appInfo?: AppInfo;
  modules?: ModuleInfo[];
  symbols?: { [moduleBase: string]: SymbolInfo[] };
}

export interface AppInfo {
  name: string;
  pid: number;
  icon?: string;
  arch?: string;
  bundleIdentifier?: string;
}

export interface ProcessInfo {
  pid: number;
  processname: string;
}

export interface ModuleInfo {
  name?: string; // deprecated, use modulename
  modulename: string;
  base_address?: string; // deprecated, use base
  base: number;
  size: number;
  path?: string;
  is_64bit?: boolean;
}

export interface InstalledAppInfo {
  bundleIdentifier: string;
  displayName: string;
  bundleVersion: string;
  bundlePath: string;
  executableName?: string;
  executablePath?: string;
  minimumOSVersion?: string;
  dataContainerPath?: string;
  iconFile?: string;
}

export interface SpawnAppResult {
  success: boolean;
  pid?: number;
  bundleIdentifier?: string;
  suspended?: boolean;
  error?: string;
  warning?: string;
}

export interface SymbolInfo {
  address: string;
  name: string;
  size: number;
  type: string;
  scope: string;
  module_base: string;
  file_name?: string;
  line_number?: number;
  // Extended Mach-O metadata (iOS/macOS only)
  is_external?: boolean;
  is_private_external?: boolean;
  is_weak_def?: boolean;
  is_weak_ref?: boolean;
  is_thumb?: boolean;
  section_index?: number;
  library_ordinal?: number;
  source?: string; // "symtab" or "export_trie"
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

export interface NetworkConnection {
  protocol: string;
  local_address: string;
  local_port: number;
  remote_address: string;
  remote_port: number;
  state: string;
  inode?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export interface SimpleResponse {
  success: boolean;
  message: string;
}

// Script Execution Types
export type ScriptJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ExecuteScriptResponse {
  success: boolean;
  job_id: string;
  message: string;
}

export interface ScriptFileUpload {
  filename: string;
  data_base64: string;
  mime_type?: string;
}

export interface ScriptStatusResponse {
  success: boolean;
  job_id: string;
  status: ScriptJobStatus;
  output: string;
  error?: string;
  trace_callback_registered: boolean;
  files: ScriptFileUpload[];
}

export interface ScriptCancelResponse {
  success: boolean;
  message: string;
}

export interface ScriptDisableResponse {
  success: boolean;
  message: string;
}

export interface ScanProgressResponse {
  scan_id: string;
  progress_percentage: number;
  scanned_bytes: number;
  total_bytes: number;
  is_scanning: boolean;
  current_region?: string;
}

class ApiClient {
  private baseUrl: string = "";
  private authToken: string | null = null;
  private serverSessionId: string | null = null;
  private connectionListeners: ((
    connected: boolean,
    error?: string
  ) => void)[] = [];
  private healthCheckInterval: number | null = null;
  private isHealthCheckRunning: boolean = false;

  constructor(baseUrl?: string) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  updateConnection(host: string, port: number) {
    const newBaseUrl = `http://${host}:${port}`;
    // Only clear auth token when actually changing to a different server
    if (this.baseUrl !== newBaseUrl) {
      this.baseUrl = newBaseUrl;
      // Clear auth token when changing connection
      this.authToken = null;
      this.serverSessionId = null;
      // Also set connection for Tauri backend
      this.setTauriServerConnection(host, port);
      // Stop any existing health check
      this.stopHealthCheck();
    }
  }

  // Add connection listener for UI updates
  addConnectionListener(
    listener: (connected: boolean, error?: string) => void
  ) {
    this.connectionListeners.push(listener);
  }

  removeConnectionListener(
    listener: (connected: boolean, error?: string) => void
  ) {
    const index = this.connectionListeners.indexOf(listener);
    if (index > -1) {
      this.connectionListeners.splice(index, 1);
    }
  }

  private notifyConnectionState(connected: boolean, error?: string) {
    this.connectionListeners.forEach((listener) => listener(connected, error));
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit,
    requireAuth: boolean = true
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: { [key: string]: string } = {
      "Content-Type": "application/json",
      ...((options?.headers as { [key: string]: string }) || {}),
    };

    // Add auth token if required and available
    if (requireAuth && this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const startTime = performance.now();

    try {
      // Add detailed timing for single step endpoint
      const isSingleStep = endpoint === "/api/debug/step";
      if (isSingleStep) {
        console.log(`[API TIMING] fetch() starting at ${Date.now()}ms`);
      }

      const response = await fetch(url, {
        ...options,
        headers,
      });

      const fetchEndTime = performance.now();
      if (isSingleStep) {
        console.log(
          `[API TIMING] fetch() completed at ${Date.now()}ms, took ${(fetchEndTime - startTime).toFixed(2)}ms`
        );
      }

      if (!response.ok) {
        // Check for authentication errors
        if (response.status === 401) {
          this.authToken = null;
          this.serverSessionId = null;
          this.notifyConnectionState(
            false,
            "Authentication failed - server may have restarted"
          );
          throw new Error("Authentication failed - please reconnect");
        } else if (response.status === 403) {
          this.notifyConnectionState(false, "Server access denied");
          throw new Error("Server access denied");
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const jsonStartTime = performance.now();
      const jsonResult = await response.json();
      if (isSingleStep) {
        console.log(
          `[API TIMING] json() parsing took ${(performance.now() - jsonStartTime).toFixed(2)}ms, total: ${(performance.now() - startTime).toFixed(2)}ms`
        );
      }
      return jsonResult;
    } catch (error) {
      // Handle network errors as potential disconnections
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        // Stop health check on network errors
        this.stopHealthCheck();
      } else if (
        error instanceof Error &&
        error.message.includes("ERR_CONNECTION_REFUSED")
      ) {
        this.notifyConnectionState(
          false,
          "Connection refused - server may have stopped"
        );
        this.stopHealthCheck();
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    if (this.authToken) {
      try {
        await this.request<any>("/api/auth/logout", {
          method: "POST",
        });
      } catch (error) {
        // Ignore logout errors
        console.warn("Logout request failed:", error);
      }
    }

    this.authToken = null;
    this.serverSessionId = null;
    // Stop health check when logging out
    this.stopHealthCheck();
  }

  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  getServerSessionId(): string | null {
    return this.serverSessionId;
  }

  // Set authentication info for new windows
  setAuthenticationInfo(authToken: string, serverSessionId?: string) {
    this.authToken = authToken;
    this.serverSessionId = serverSessionId || null;
    console.log("Authentication info set:", {
      hasToken: !!authToken,
      hasSessionId: !!serverSessionId,
    });
  }

  // Get current authentication info
  getAuthenticationInfo(): {
    authToken: string | null;
    serverSessionId: string | null;
  } {
    return {
      authToken: this.authToken,
      serverSessionId: this.serverSessionId,
    };
  }

  // Health check
  async healthCheck(): Promise<any> {
    return this.request<any>("/health", undefined, false);
  }

  // Start periodic health check
  startHealthCheck(intervalMs: number = 5000) {
    if (this.healthCheckInterval) {
      this.stopHealthCheck();
    }

    this.isHealthCheckRunning = true;
    this.healthCheckInterval = window.setInterval(async () => {
      if (!this.isHealthCheckRunning) {
        return;
      }

      try {
        await this.healthCheck();
        // Health check succeeded, no action needed
      } catch (error) {
        console.warn("Health check failed:", error);
        // Notify listeners about connection loss
        this.notifyConnectionState(false, "Server connection lost");
        this.stopHealthCheck();
      }
    }, intervalMs);
  }

  // Stop health check
  stopHealthCheck() {
    this.isHealthCheckRunning = false;
    if (this.healthCheckInterval) {
      window.clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async getServerInfo(): Promise<ServerInfo> {
    return this.request<ServerInfo>("/api/server/info");
  }

  // Process management
  async enumerateProcesses(): Promise<ProcessInfo[]> {
    return this.request<ProcessInfo[]>("/api/processes");
  }

  async attachProcess(pid: number): Promise<SimpleResponse> {
    return this.request<SimpleResponse>(`/api/processes/${pid}/attach`, {
      method: "POST",
    });
  }

  async getProcessInfo(): Promise<ApiResponse<AppInfo>> {
    return this.request<ApiResponse<AppInfo>>("/api/process/info");
  }

  async changeProcessState(doPlay: boolean): Promise<SimpleResponse> {
    return this.request<SimpleResponse>("/api/process/state", {
      method: "PUT",
      body: JSON.stringify({ do_play: doPlay }),
    });
  }

  async getProcessIcon(pid: number): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/processes/${pid}/icon`,
        {
          headers: this.authToken
            ? { Authorization: `Bearer ${this.authToken}` }
            : {},
        }
      );

      if (response.status === 401) {
        this.authToken = null;
        this.serverSessionId = null;
        this.notifyConnectionState(
          false,
          "Authentication failed - server may have restarted"
        );
        return null;
      }

      if (response.ok) {
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      }
      return null;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      console.debug(`Failed to get icon for process ${pid}:`, error);
      return null;
    }
  }

  // Module management
  async enumerateModules(): Promise<ApiResponse<{ modules: ModuleInfo[] }>> {
    return this.request<ApiResponse<{ modules: ModuleInfo[] }>>("/api/modules");
  }

  // Thread management
  async enumerateThreads(): Promise<ApiResponse<{ threads: ThreadInfo[] }>> {
    return this.request<ApiResponse<{ threads: ThreadInfo[] }>>("/api/threads");
  }

  // Network connections
  async enumerateNetwork(): Promise<
    ApiResponse<{ connections: NetworkConnection[] }>
  > {
    return this.request<ApiResponse<{ connections: NetworkConnection[] }>>(
      "/api/network"
    );
  }

  async enumerateSymbols(
    moduleBase: string
  ): Promise<ApiResponse<{ symbols: SymbolInfo[] }>> {
    const baseAddress = parseInt(moduleBase.replace("0x", ""), 16);
    return this.request<ApiResponse<{ symbols: SymbolInfo[] }>>(
      `/api/modules/${baseAddress}/symbols`
    );
  }

  async enumerateSymbolsForModule(module: ModuleInfo): Promise<SymbolInfo[]> {
    try {
      const baseAddress =
        module.base_address || `0x${module.base.toString(16)}`;
      const response = await this.enumerateSymbols(baseAddress);
      return response.data?.symbols || [];
    } catch (error) {
      const moduleName = module.name || module.modulename;
      console.error(
        `Failed to enumerate symbols for module ${moduleName}:`,
        error
      );
      return [];
    }
  }

  async enumerateAllSymbols(
    modules: ModuleInfo[]
  ): Promise<{ [moduleBase: string]: SymbolInfo[] }> {
    const symbolsMap: { [moduleBase: string]: SymbolInfo[] } = {};

    for (const module of modules) {
      try {
        const symbols = await this.enumerateSymbolsForModule(module);
        const baseKey = module.base_address || `0x${module.base.toString(16)}`;
        symbolsMap[baseKey] = symbols;
      } catch (error) {
        const moduleName = module.name || module.modulename;
        const baseKey = module.base_address || `0x${module.base.toString(16)}`;
        console.error(
          `Failed to enumerate symbols for module ${moduleName}:`,
          error
        );
        symbolsMap[baseKey] = [];
      }
    }

    return symbolsMap;
  }

  // Memory operations
  async readMemory(
    address: string,
    size: number,
    usePtrace: boolean = false
  ): Promise<ArrayBuffer> {
    // Convert hex address to decimal for API compatibility
    let numericAddress: number;
    if (address.startsWith("0x") || address.startsWith("0X")) {
      numericAddress = parseInt(address, 16);
    } else {
      numericAddress = parseInt(address, 10);
    }

    if (isNaN(numericAddress) || numericAddress < 0) {
      throw new Error(`Invalid address format: ${address}`);
    }

    try {
      const headers: { [key: string]: string } = {};
      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }

      const usePtraceParam = usePtrace ? "&use_ptrace=true" : "";
      const response = await fetch(
        `${this.baseUrl}/api/memory/read?address=${numericAddress}&size=${size}${usePtraceParam}`,
        { headers }
      );

      if (!response.ok) {
        // Handle authentication errors
        if (response.status === 401) {
          this.authToken = null;
          this.serverSessionId = null;
          this.notifyConnectionState(
            false,
            "Authentication failed - server may have restarted"
          );
          throw new Error("Authentication failed - please reconnect");
        } else if (response.status === 403) {
          this.notifyConnectionState(false, "Server access denied");
          throw new Error("Server access denied");
        }

        const errorText = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${response.statusText} - ${errorText}`
        );
      }

      return response.arrayBuffer();
    } catch (error) {
      // Handle network errors
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      console.error(
        `Failed to read memory at ${address} (${numericAddress}):`,
        error
      );
      throw error;
    }
  }

  async writeMemory(address: string, buffer: ArrayBuffer): Promise<string> {
    const response = await this.request<any>("/api/memory/write", {
      method: "POST",
      body: JSON.stringify({
        address: parseInt(address.replace("0x", ""), 16),
        buffer: Array.from(new Uint8Array(buffer)),
      }),
    });
    return typeof response === "string" ? response : JSON.stringify(response);
  }

  async enumerateRegions(
    includeFilePath: boolean = true
  ): Promise<{ regions: any[] }> {
    return this.request<{ regions: any[] }>(
      `/api/memory/regions?include_file_path=${includeFilePath}`
    );
  }

  // Memory analysis
  async memoryScan(scanRequest: any): Promise<any> {
    return this.request<any>("/api/memory/scan", {
      method: "POST",
      body: JSON.stringify(scanRequest),
    });
  }

  // YARA memory scan
  async yaraScan(scanRequest: {
    rule: string;
    address_ranges: [number, number][];
    scan_id: string;
    align: number;
    do_suspend: boolean;
  }): Promise<{
    success: boolean;
    message: string;
    scan_id: string;
    matches: {
      rule_name: string;
      address: number;
      length: number;
      pattern_id: string;
      matched_data: string;
    }[];
    total_matches: number;
    scanned_bytes: number;
  }> {
    return this.request("/api/memory/yara", {
      method: "POST",
      body: JSON.stringify(scanRequest),
    });
  }

  async memoryFilter(filterRequest: FilterRequest): Promise<FilterResponse> {
    return this.request<FilterResponse>("/api/memory/filter", {
      method: "POST",
      body: JSON.stringify(filterRequest),
    });
  }

  async getScanProgress(
    scanId: string
  ): Promise<ApiResponse<ScanProgressResponse>> {
    return this.request<ApiResponse<ScanProgressResponse>>(
      "/api/memory/scan/progress",
      {
        method: "POST",
        body: JSON.stringify({ scan_id: scanId }),
      }
    );
  }

  async getFilterProgress(
    filterId: string
  ): Promise<ApiResponse<FilterProgressResponse>> {
    return this.request<ApiResponse<FilterProgressResponse>>(
      "/api/memory/filter/progress",
      {
        method: "POST",
        body: JSON.stringify({ filter_id: filterId }),
      }
    );
  }

  async getScanResults(scanId: string): Promise<any> {
    return this.request<any>("/api/memory/scan/results", {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId }),
    });
  }

  async getFilterResults(scanId: string): Promise<any> {
    return this.request<any>("/api/memory/filter/results", {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId }),
    });
  }

  async stopScan(scanId: string): Promise<SimpleResponse> {
    return this.request<SimpleResponse>("/api/memory/scan/stop", {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId }),
    });
  }

  async clearScan(scanId: string): Promise<SimpleResponse> {
    return this.request<SimpleResponse>("/api/memory/scan/clear", {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId }),
    });
  }

  // Tauri-specific disassembly (using local Rust implementation)
  async disassembleMemoryLocal(
    request: DisassembleRequest
  ): Promise<DisassembleResponse> {
    try {
      return await invoke<DisassembleResponse>("disassemble_memory", {
        request,
      });
    } catch (error) {
      return {
        success: false,
        instructions_count: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Set server connection for Tauri backend
  async setTauriServerConnection(host: string, port: number): Promise<void> {
    try {
      await invoke("set_server_connection", { host, port });
    } catch (error) {
      console.error("Failed to set Tauri server connection:", error);
    }
  }

  // Read memory using Tauri backend
  async readMemoryLocal(
    address: number,
    size: number
  ): Promise<MemoryReadResponse> {
    try {
      return await invoke<MemoryReadResponse>("read_memory", { address, size });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Native memory filter using Tauri backend (processes filter locally with network memory reads)
  async filterMemoryNative(
    request: NativeMemoryFilterRequest
  ): Promise<NativeMemoryFilterResponse> {
    try {
      return await invoke<NativeMemoryFilterResponse>("filter_memory_native", {
        request,
      });
    } catch (error) {
      return {
        success: false,
        results: [],
        total_processed: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Native memory lookup using Tauri backend (reads current values for addresses)
  async lookupMemoryNative(
    addresses: number[],
    dataType: string
  ): Promise<NativeMemoryFilterResponse> {
    try {
      return await invoke<NativeMemoryFilterResponse>("lookup_memory_native", {
        addresses,
        data_type: dataType,
      });
    } catch (error) {
      return {
        success: false,
        results: [],
        total_processed: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ============================================================================
  // Unknown Scan Streaming API (Server-side)
  // ============================================================================

  // Start unknown scan on server (streams compressed chunks)
  async unknownScanStart(
    request: UnknownScanStartRequest
  ): Promise<UnknownScanStartResponse> {
    return await this.request<UnknownScanStartResponse>(
      "/api/memory/unknown-scan/start",
      {
        method: "POST",
        body: JSON.stringify(request),
      }
    );
  }

  // Get streamed unknown scan data (chunks are removed from server after retrieval)
  async unknownScanStream(scanId: string): Promise<UnknownScanStreamResponse> {
    const response = await this.request<
      { success: boolean } & UnknownScanStreamResponse
    >("/api/memory/unknown-scan/stream", {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId }),
    });
    return response;
  }

  // Stop unknown scan
  async unknownScanStop(
    scanId: string
  ): Promise<{ success: boolean; message: string }> {
    return await this.request<{ success: boolean; message: string }>(
      "/api/memory/unknown-scan/stop",
      {
        method: "POST",
        body: JSON.stringify({ scan_id: scanId }),
      }
    );
  }

  // ============================================================================
  // Legacy Tauri-based Unknown Scan (for backward compatibility)
  // ============================================================================

  // Native unknown scan using Tauri backend (scans memory ranges for unknown initial value)
  // Results are stored in temp files, use getUnknownScanProgress to poll progress
  async unknownScanNative(
    request: NativeUnknownScanRequest
  ): Promise<NativeUnknownScanResponse> {
    try {
      return await invoke<NativeUnknownScanResponse>("unknown_scan_native", {
        request,
      });
    } catch (error) {
      return {
        success: false,
        scan_id: request.scan_id,
        total_addresses: 0,
        temp_dir: "",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Initialize unknown scan progress (call before starting scan to prevent race condition)
  async initUnknownScanProgress(
    scanId: string,
    totalBytes: number
  ): Promise<void> {
    try {
      await invoke("init_unknown_scan_progress", {
        scanId: scanId,
        totalBytes: totalBytes,
      });
    } catch (error) {
      console.error("Failed to init unknown scan progress:", error);
    }
  }

  // Get unknown scan progress
  async getUnknownScanProgress(
    scanId: string
  ): Promise<NativeUnknownScanProgress> {
    try {
      return await invoke<NativeUnknownScanProgress>(
        "get_unknown_scan_progress",
        {
          scanId: scanId,
        }
      );
    } catch (error) {
      return {
        scan_id: scanId,
        progress_percentage: 0,
        processed_bytes: 0,
        total_bytes: 0,
        found_count: 0,
        is_scanning: false,
        current_region: undefined,
      };
    }
  }

  // Load unknown scan results from temp files (for display)
  async loadUnknownScanResults(
    scanId: string,
    offset: number,
    limit: number
  ): Promise<NativeUnknownScanLookupResponse> {
    try {
      return await invoke<NativeUnknownScanLookupResponse>(
        "load_unknown_scan_results",
        {
          scanId: scanId,
          offset,
          limit,
        }
      );
    } catch (error) {
      return {
        success: false,
        results: [],
        total_count: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Clear unknown scan temp files
  async clearUnknownScan(scanId: string): Promise<boolean> {
    try {
      return await invoke<boolean>("clear_unknown_scan", {
        scanId: scanId,
      });
    } catch (error) {
      return false;
    }
  }

  // Disassemble memory using Tauri backend with Capstone
  async disassembleWithCapstone(
    address: string,
    size: number,
    architecture: string = "arm64"
  ): Promise<DisassembleResponse> {
    try {
      // Convert address to number
      let numericAddress: number;
      if (address.startsWith("0x") || address.startsWith("0X")) {
        numericAddress = parseInt(address, 16);
      } else {
        numericAddress = parseInt(address, 10);
      }

      if (isNaN(numericAddress) || numericAddress < 0) {
        return {
          success: false,
          instructions_count: 0,
          error: `Invalid address format: ${address}`,
        };
      }

      const request = {
        address: numericAddress,
        size,
        architecture,
      };

      return await invoke<DisassembleResponse>("disassemble_memory", request);
    } catch (error) {
      return {
        success: false,
        instructions_count: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Debug operations
  async setWatchpoint(request: {
    address: number;
    size: number;
    _type: string;
  }): Promise<{
    success: boolean;
    message: string;
    watchpoint_id?: string;
  }> {
    return this.request<{
      success: boolean;
      message: string;
      watchpoint_id?: string;
    }>("/api/debug/watchpoint", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async removeWatchpoint(request: {
    address: number;
  }): Promise<SimpleResponse> {
    return this.request<SimpleResponse>("/api/debug/watchpoint", {
      method: "DELETE",
      body: JSON.stringify(request),
    });
  }

  async listWatchpoints(): Promise<{
    success: boolean;
    watchpoints: WatchpointInfo[];
    message?: string;
  }> {
    return this.request<{
      success: boolean;
      watchpoints: WatchpointInfo[];
      message?: string;
    }>("/api/debug/watchpoints", {
      method: "GET",
    });
  }

  async setBreakpoint(request: {
    address: number;
    hit_count: number;
    trace_to_file?: boolean;
    trace_file_path?: string;
    end_address?: number; // Optional end address for trace
    full_memory_cache?: boolean; // If true, dump initial memory and log all memory accesses
    is_software?: boolean; // If true, use software breakpoint instead of hardware
  }): Promise<{
    success: boolean;
    message: string;
    trace_file_path?: string;
  }> {
    return this.request<{
      success: boolean;
      message: string;
      trace_file_path?: string;
    }>("/api/debug/breakpoint", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async removeBreakpoint(request: {
    address: number;
  }): Promise<SimpleResponse> {
    return this.request<SimpleResponse>("/api/debug/breakpoint", {
      method: "DELETE",
      body: JSON.stringify(request),
    });
  }

  // Get original instruction bytes for a software breakpoint
  async getSoftwareBreakpointBytes(address: number): Promise<{
    success: boolean;
    address: number;
    original_bytes: string;
    size: number;
    message?: string;
  }> {
    return this.request<{
      success: boolean;
      address: number;
      original_bytes: string;
      size: number;
      message?: string;
    }>(`/api/debug/breakpoint/software/${address}`, {
      method: "GET",
    });
  }

  // Trace status
  async getTraceStatus(): Promise<{
    success: boolean;
    enabled: boolean;
    file_path?: string;
    entry_count: number;
    ended_by_end_address: boolean;
    message: string;
  }> {
    // Check if baseUrl is set
    if (!this.baseUrl) {
      throw new Error("Server not connected - baseUrl is empty");
    }

    const url = `${this.baseUrl}/api/debug/trace/status`;
    const headers: { [key: string]: string } = {
      "Content-Type": "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  // Download trace file as binary
  async downloadTraceFile(): Promise<Blob> {
    const headers: Record<string, string> = {
      Accept: "application/octet-stream",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(
      `${this.baseUrl}/api/debug/trace/file/download`,
      {
        method: "GET",
        headers,
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to download trace file: ${response.statusText}`);
    }

    return await response.blob();
  }

  async getExceptionInfo(
    exceptionTypes?: string[],
    singlestepModes?: number[]
  ): Promise<{
    success: boolean;
    exceptions: ExceptionInfo[];
    message?: string;
  }> {
    let url = "/api/debug/exception";
    const queryParams: string[] = [];

    // Add exception type filter if specified
    if (exceptionTypes && exceptionTypes.length > 0) {
      const queryParam = exceptionTypes.join(",");
      queryParams.push(`exception_type=${encodeURIComponent(queryParam)}`);
    }

    // Add singlestep_mode filter if specified
    if (singlestepModes && singlestepModes.length > 0) {
      const queryParam = singlestepModes.join(",");
      queryParams.push(`singlestep_mode=${encodeURIComponent(queryParam)}`);
    }

    // Combine query parameters
    if (queryParams.length > 0) {
      url += `?${queryParams.join("&")}`;
    }

    const response = await this.request<{
      success: boolean;
      data?: {
        exceptions: ExceptionInfo[];
      };
      message?: string;
    }>(url, {
      method: "GET",
    });

    // Transform the response to match the expected format
    return {
      success: response.success,
      exceptions: response.data?.exceptions || [],
      message: response.message,
    };
  }

  // Signal configuration (catch/pass)
  // SignalConfig: { catch_signal: boolean, pass_signal: boolean }
  // - catch=true: Stop debugger on signal
  // - pass=true: Deliver signal to process on continue
  async getSignalConfigs(): Promise<{
    success: boolean;
    configs: Array<{
      signal: number;
      catch_signal: boolean;
      pass_signal: boolean;
    }>;
  }> {
    return this.request<{
      success: boolean;
      configs: Array<{
        signal: number;
        catch_signal: boolean;
        pass_signal: boolean;
      }>;
    }>("/api/debug/signals", {
      method: "GET",
    });
  }

  async setSignalConfig(
    signal: number,
    catch_signal: boolean,
    pass_signal: boolean
  ): Promise<{
    success: boolean;
    configs: Array<{
      signal: number;
      catch_signal: boolean;
      pass_signal: boolean;
    }>;
  }> {
    return this.request<{
      success: boolean;
      configs: Array<{
        signal: number;
        catch_signal: boolean;
        pass_signal: boolean;
      }>;
    }>("/api/debug/signals", {
      method: "POST",
      body: JSON.stringify({ signal, catch_signal, pass_signal }),
    });
  }

  async setAllSignalConfigs(
    configs: Array<{
      signal: number;
      catch_signal: boolean;
      pass_signal: boolean;
    }>
  ): Promise<{
    success: boolean;
    configs: Array<{
      signal: number;
      catch_signal: boolean;
      pass_signal: boolean;
    }>;
  }> {
    return this.request<{
      success: boolean;
      configs: Array<{
        signal: number;
        catch_signal: boolean;
        pass_signal: boolean;
      }>;
    }>("/api/debug/signals/all", {
      method: "PUT",
      body: JSON.stringify({ configs }),
    });
  }

  async removeSignalConfig(signal: number): Promise<{
    success: boolean;
    configs: Array<{
      signal: number;
      catch_signal: boolean;
      pass_signal: boolean;
    }>;
  }> {
    return this.request<{
      success: boolean;
      configs: Array<{
        signal: number;
        catch_signal: boolean;
        pass_signal: boolean;
      }>;
    }>("/api/debug/signals/remove", {
      method: "POST",
      body: JSON.stringify({ signal }),
    });
  }

  // New break state control methods
  async continueExecution(threadId?: number): Promise<SimpleResponse> {
    const body = threadId ? { thread_id: threadId } : {};
    return this.request<SimpleResponse>("/api/debug/continue", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async continueExecutionMultiple(threadIds: number[]): Promise<{
    success: boolean;
    message: string;
    results?: Array<{ thread_id: number; success: boolean; message: string }>;
  }> {
    const body = { thread_ids: threadIds };
    return this.request<{
      success: boolean;
      message: string;
      results?: Array<{ thread_id: number; success: boolean; message: string }>;
    }>("/api/debug/continue", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async singleStep(threadId?: number): Promise<SimpleResponse> {
    const body = { thread_id: threadId || 0 };
    return this.request<SimpleResponse>("/api/debug/step", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async readRegister(
    registerName: string,
    threadId?: number
  ): Promise<{
    success: boolean;
    register_name: string;
    value?: number;
    message: string;
  }> {
    const body = threadId
      ? { register_name: registerName, thread_id: threadId }
      : { register_name: registerName };
    return this.request<{
      success: boolean;
      register_name: string;
      value?: number;
      message: string;
    }>("/api/debug/register/read", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async writeRegister(
    registerName: string,
    value: number,
    threadId: number
  ): Promise<SimpleResponse> {
    const body = { register_name: registerName, value, thread_id: threadId };
    return this.request<SimpleResponse>("/api/debug/register/write", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getDebugState(): Promise<{
    success: boolean;
    is_in_break_state: boolean;
    message: string;
  }> {
    return this.request<{
      success: boolean;
      is_in_break_state: boolean;
      message: string;
    }>("/api/debug/state");
  }

  async disassemble(request: {
    address: number;
    size: number;
    architecture: string;
  }): Promise<{
    success: boolean;
    disassembly?: string;
    instructions_count: number;
    error?: string;
  }> {
    return this.request<{
      success: boolean;
      disassembly?: string;
      instructions_count: number;
      error?: string;
    }>("/api/memory/disassemble", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  // Utility functions
  async resolveAddress(
    query: string
  ): Promise<ApiResponse<{ address: number }>> {
    return this.request<ApiResponse<{ address: number }>>(
      `/api/memory/resolve?query=${encodeURIComponent(query)}`
    );
  }

  async exploreDirectory(path: string, maxDepth: number = 3): Promise<any> {
    return this.request<any>(
      `/api/utils/directory?path=${encodeURIComponent(path)}&max_depth=${maxDepth}`
    );
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const headers: { [key: string]: string } = {};
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/utils/file?path=${encodeURIComponent(path)}`,
        { headers }
      );

      if (!response.ok) {
        // Handle authentication errors
        if (response.status === 401) {
          this.authToken = null;
          this.serverSessionId = null;
          this.notifyConnectionState(
            false,
            "Authentication failed - server may have restarted"
          );
          throw new Error("Authentication failed - please reconnect");
        } else if (response.status === 403) {
          this.notifyConnectionState(false, "Server access denied");
          throw new Error("Server access denied");
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.arrayBuffer();
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      throw error;
    }
  }

  async uploadFile(
    path: string,
    data: ArrayBuffer
  ): Promise<{ success: boolean; path: string; error?: string }> {
    const headers: { [key: string]: string } = {};
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/utils/file?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          headers,
          body: data,
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          this.authToken = null;
          this.serverSessionId = null;
          this.notifyConnectionState(
            false,
            "Authentication failed - server may have restarted"
          );
          throw new Error("Authentication failed - please reconnect");
        } else if (response.status === 403) {
          this.notifyConnectionState(false, "Server access denied");
          throw new Error("Server access denied");
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      throw error;
    }
  }

  async generatePointerScan(request: any): Promise<ArrayBuffer> {
    const headers: { [key: string]: string } = {
      "Content-Type": "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/memory/pointer-scan`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        // Handle authentication errors
        if (response.status === 401) {
          this.authToken = null;
          this.serverSessionId = null;
          this.notifyConnectionState(
            false,
            "Authentication failed - server may have restarted"
          );
          throw new Error("Authentication failed - please reconnect");
        } else if (response.status === 403) {
          this.notifyConnectionState(false, "Server access denied");
          throw new Error("Server access denied");
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.arrayBuffer();
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      throw error;
    }
  }

  /**
   * Generate a full pointermap for the entire process memory
   * Returns LZ4 compressed binary data in DynaDbg PointerMap format (.dptr)
   */
  async generatePointerMap(): Promise<ArrayBuffer> {
    const headers: { [key: string]: string } = {};
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/memory/pointermap`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        if (response.status === 401) {
          this.authToken = null;
          this.serverSessionId = null;
          this.notifyConnectionState(
            false,
            "Authentication failed - server may have restarted"
          );
          throw new Error("Authentication failed - please reconnect");
        } else if (response.status === 403) {
          this.notifyConnectionState(false, "Server access denied");
          throw new Error("Server access denied");
        }

        try {
          const errorData = await response.json();
          throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        } catch {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      return response.arrayBuffer();
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      throw error;
    }
  }

  /**
   * Start pointermap generation with progress tracking
   */
  async startPointerMapGeneration(): Promise<{ success: boolean; task_id: string; message: string }> {
    return this.request<{ success: boolean; task_id: string; message: string }>(
      "/api/memory/pointermap/start",
      { method: "POST" }
    );
  }

  /**
   * Get pointermap generation progress
   */
  async getPointerMapProgress(taskId: string): Promise<{
    task_id: string;
    progress_percentage: number;
    current_phase: string;
    processed_regions: number;
    total_regions: number;
    processed_bytes: number;
    total_bytes: number;
    is_generating: boolean;
    is_complete: boolean;
    error: string | null;
  }> {
    return this.request("/api/memory/pointermap/progress", {
      method: "POST",
      body: JSON.stringify({ task_id: taskId }),
    });
  }

  /**
   * Download completed pointermap data
   */
  async downloadPointerMap(taskId: string): Promise<ArrayBuffer> {
    const headers: { [key: string]: string } = {
      "Content-Type": "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(`${this.baseUrl}/api/memory/pointermap/download`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task_id: taskId }),
    });

    if (!response.ok) {
      try {
        const errorData = await response.json();
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      } catch {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }

    return response.arrayBuffer();
  }

  // App management APIs (iOS)
  async getInstalledApps(): Promise<ApiResponse<{ apps: InstalledAppInfo[] }>> {
    return this.request<ApiResponse<{ apps: InstalledAppInfo[] }>>("/api/apps");
  }

  async getAppIcon(bundleIdentifier: string): Promise<string | null> {
    try {
      const headers: { [key: string]: string } = {};
      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }

      const response = await fetch(
        `${this.baseUrl}/api/apps/icon?bundle_identifier=${encodeURIComponent(bundleIdentifier)}`,
        { headers }
      );

      if (response.status === 401) {
        this.authToken = null;
        this.serverSessionId = null;
        this.notifyConnectionState(
          false,
          "Authentication failed - server may have restarted"
        );
        return null;
      }

      if (response.ok) {
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      }
      return null;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this.notifyConnectionState(
          false,
          "Network error - server may be unreachable"
        );
        this.stopHealthCheck();
      }
      console.debug(`Failed to get icon for app ${bundleIdentifier}:`, error);
      return null;
    }
  }

  async spawnApp(
    bundleIdentifier: string,
    suspended: boolean = true
  ): Promise<ApiResponse<SpawnAppResult>> {
    return this.request<ApiResponse<SpawnAppResult>>("/api/apps/spawn", {
      method: "POST",
      body: JSON.stringify({
        bundle_identifier: bundleIdentifier,
        suspended,
      }),
    });
  }

  // Spawn a process from executable path (Linux)
  async spawnProcess(
    executablePath: string,
    args: string[] = []
  ): Promise<ApiResponse<{ pid: number; success: boolean }>> {
    return this.request<ApiResponse<{ pid: number; success: boolean }>>(
      "/api/process/spawn",
      {
        method: "POST",
        body: JSON.stringify({
          executable_path: executablePath,
          args,
        }),
      }
    );
  }

  // Spawn a process with PTY for terminal I/O (Linux)
  async spawnProcessWithPty(
    executablePath: string,
    args: string[] = []
  ): Promise<ApiResponse<{ pid: number; pty_fd: number; success: boolean }>> {
    return this.request<
      ApiResponse<{ pid: number; pty_fd: number; success: boolean }>
    >("/api/process/spawn-pty", {
      method: "POST",
      body: JSON.stringify({
        executable_path: executablePath,
        args,
      }),
    });
  }

  // Read from PTY (returns base64 encoded data)
  async ptyRead(
    ptyFd: number
  ): Promise<ApiResponse<{ data: string; bytes: number }>> {
    return this.request<ApiResponse<{ data: string; bytes: number }>>(
      `/api/pty/${ptyFd}/read`
    );
  }

  // Write to PTY
  async ptyWrite(
    ptyFd: number,
    data: string
  ): Promise<ApiResponse<{ bytes_written: number }>> {
    return this.request<ApiResponse<{ bytes_written: number }>>(
      "/api/pty/write",
      {
        method: "POST",
        body: JSON.stringify({
          pty_fd: ptyFd,
          data,
        }),
      }
    );
  }

  // Resize PTY window
  async ptyResize(
    ptyFd: number,
    rows: number,
    cols: number
  ): Promise<ApiResponse<{ success: boolean }>> {
    return this.request<ApiResponse<{ success: boolean }>>("/api/pty/resize", {
      method: "POST",
      body: JSON.stringify({
        pty_fd: ptyFd,
        rows,
        cols,
      }),
    });
  }

  // Close PTY
  async ptyClose(ptyFd: number): Promise<ApiResponse<{ success: boolean }>> {
    return this.request<ApiResponse<{ success: boolean }>>(
      `/api/pty/${ptyFd}/close`,
      {
        method: "POST",
      }
    );
  }

  async terminateApp(
    pid: number | string
  ): Promise<ApiResponse<{ terminated: boolean; pid: number }>> {
    const pidNum = typeof pid === "string" ? parseInt(pid, 10) : pid;
    return this.request<ApiResponse<{ terminated: boolean; pid: number }>>(
      "/api/apps/terminate",
      {
        method: "POST",
        body: JSON.stringify({
          pid: pidNum,
        }),
      }
    );
  }

  // Resume a suspended spawned app
  async resumeApp(
    pid: number
  ): Promise<ApiResponse<{ success: boolean; pid: number; resumed: boolean }>> {
    return this.request<
      ApiResponse<{ success: boolean; pid: number; resumed: boolean }>
    >("/api/apps/resume", {
      method: "POST",
      body: JSON.stringify({
        pid,
      }),
    });
  }

  // Check if an app is running and get its PID
  async getAppRunningStatus(
    bundleIdentifier: string
  ): Promise<
    ApiResponse<{ running: boolean; pid: number; bundle_identifier: string }>
  > {
    return this.request<
      ApiResponse<{ running: boolean; pid: number; bundle_identifier: string }>
    >(
      `/api/apps/status?bundle_identifier=${encodeURIComponent(bundleIdentifier)}`
    );
  }

  // =============================================
  // ObjC Dynamic Analyzer APIs
  // =============================================

  /**
   * Get list of all Objective-C classes
   * @param filter Optional filter string to match class names
   */
  async getObjcClassList(filter?: string): Promise<
    ApiResponse<{
      classes: import("../types").ObjcClassInfo[];
      total_count: number;
    }>
  > {
    const url = filter
      ? `/api/objc/classes?filter=${encodeURIComponent(filter)}`
      : "/api/objc/classes";
    return this.request<
      ApiResponse<{
        classes: import("../types").ObjcClassInfo[];
        total_count: number;
      }>
    >(url);
  }

  /**
   * Get methods for a specific Objective-C class
   * @param className The name of the class to get methods for
   */
  async getObjcMethods(className: string): Promise<
    ApiResponse<{
      methods: import("../types").ObjcMethodInfo[];
      total_count: number;
      class_name: string;
    }>
  > {
    return this.request<
      ApiResponse<{
        methods: import("../types").ObjcMethodInfo[];
        total_count: number;
        class_name: string;
      }>
    >(`/api/objc/methods?class_name=${encodeURIComponent(className)}`);
  }

  /**
   * Get instance variables (ivars) for a specific Objective-C class
   * @param className The name of the class to get ivars for
   */
  async getObjcIvars(className: string): Promise<
    ApiResponse<{
      ivars: import("../types").ObjcIvarInfo[];
      total_count: number;
      class_name: string;
    }>
  > {
    return this.request<
      ApiResponse<{
        ivars: import("../types").ObjcIvarInfo[];
        total_count: number;
        class_name: string;
      }>
    >(`/api/objc/ivars?class_name=${encodeURIComponent(className)}`);
  }

  /**
   * Get properties for a specific Objective-C class
   * @param className The name of the class to get properties for
   */
  async getObjcProperties(className: string): Promise<
    ApiResponse<{
      properties: import("../types").ObjcPropertyInfo[];
      total_count: number;
      class_name: string;
    }>
  > {
    return this.request<
      ApiResponse<{
        properties: import("../types").ObjcPropertyInfo[];
        total_count: number;
        class_name: string;
      }>
    >(`/api/objc/properties?class_name=${encodeURIComponent(className)}`);
  }

  /**
   * Get protocols adopted by a specific Objective-C class
   * @param className The name of the class to get protocols for
   */
  async getObjcProtocols(className: string): Promise<
    ApiResponse<{
      protocols: import("../types").ObjcProtocolInfo[];
      total_count: number;
      class_name: string;
    }>
  > {
    return this.request<
      ApiResponse<{
        protocols: import("../types").ObjcProtocolInfo[];
        total_count: number;
        class_name: string;
      }>
    >(`/api/objc/protocols?class_name=${encodeURIComponent(className)}`);
  }

  // =============================================
  // Script Execution APIs
  // =============================================

  /**
   * Execute a Python script using DynaDbg API (async execution)
   * Returns a job ID for status tracking
   * @param script Python script source code
   */
  async executeScript(script: string): Promise<ExecuteScriptResponse> {
    return this.request<ExecuteScriptResponse>("/api/script/execute", {
      method: "POST",
      body: JSON.stringify({ script }),
    });
  }

  /**
   * Get the status of a script execution job
   * @param jobId The job ID returned from executeScript
   */
  async getScriptStatus(jobId: string): Promise<ScriptStatusResponse> {
    return this.request<ScriptStatusResponse>(`/api/script/status/${jobId}`);
  }

  /**
   * Cancel a running script execution job
   * @param jobId The job ID to cancel
   */
  async cancelScript(jobId: string): Promise<ScriptCancelResponse> {
    return this.request<ScriptCancelResponse>(`/api/script/${jobId}`, {
      method: "DELETE",
    });
  }

  /**
   * Disable script session - removes all script-owned breakpoints and clears state
   */
  async disableScript(): Promise<ScriptDisableResponse> {
    return this.request<ScriptDisableResponse>("/api/script/disable", {
      method: "POST",
    });
  }

  // =============================================
  // WASM Binary APIs
  // =============================================

  /**
   * Dump the entire WASM binary from Chrome extension
   * Returns ArrayBuffer of the WASM module
   */
  async dumpWasmBinary(): Promise<ArrayBuffer | null> {
    const url = `${this.baseUrl}/api/wasm/dump`;
    const headers: { [key: string]: string } = {};
    
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        console.error(`WASM dump failed: ${response.status}`);
        return null;
      }
      
      return await response.arrayBuffer();
    } catch (error) {
      console.error("Failed to dump WASM binary:", error);
      return null;
    }
  }

  /**
   * Get WASM module info from Chrome extension
   */
  async getWasmModuleInfo(): Promise<{
    codeSize: number;
    hasBinary: boolean;
    hasSnapshot: boolean;
  } | null> {
    try {
      const response = await this.request<{
        module_info: { codeSize: number };
        has_binary: boolean;
        has_snapshot: boolean;
      }>("/api/wasm/info");
      
      return {
        codeSize: response.module_info?.codeSize || 0,
        hasBinary: response.has_binary || false,
        hasSnapshot: response.has_snapshot || false,
      };
    } catch (error) {
      console.error("Failed to get WASM module info:", error);
      return null;
    }
  }
}

// Global API client instance
let apiClient: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (!apiClient) {
    apiClient = new ApiClient();
  }
  return apiClient;
}

// Export ApiClient class for standalone window usage
export { ApiClient };
