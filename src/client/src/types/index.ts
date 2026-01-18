// TypeScript interfaces and types
export interface Operand {
  type: "reg" | "imm" | "mem" | "shift" | "cond" | "label";
  value?: string;
  base?: string;
  disp?: string;
  index?: string;
  scale?: number;
  shift?: string;
  amount?: string | number;
}

export interface Instruction {
  address: string;
  bytes: string;
  opcode: string;
  operands: Operand[];
  comment: string;
  active: boolean;
  breakpoint: boolean;
  jumpTarget: boolean;
  isFunction?: boolean;
  isFunctionStart?: boolean;
  isFunctionEnd?: boolean;
}

export interface HexRow {
  address: string;
  bytes: string[];
  ascii: string;
  modified: number[];
  highlighted: number[];
}

export interface MemoryRegion {
  start: string;
  end: string;
  protection: string;
  name: string;
  type: "code" | "data" | "heap" | "stack" | "unknown";
}

export interface Register {
  name: string;
  value: string;
  changed: boolean;
  type: "gpr" | "fpr" | "vector" | "special";
}

export interface ThreadInfo {
  id: string;
  name: string;
  state: "running" | "stopped" | "waiting";
  pc: string;
}

export interface FunctionInfo {
  name: string;
  address: string;
  size: number;
  instructions: Instruction[];
}

export interface DebuggerState {
  connected: boolean;
  state: "running" | "paused" | "stopped";
  currentAddress: string;
  currentFunction: string;
}

export interface UIState {
  currentMode: "debugger" | "server";
  tabValue: number;
  showToolbar: boolean;
  showRegisters: boolean;
  currentEndianness: "little" | "big";
  currentCodePage: string;
}

export type AppMode = "debugger" | "server" | "scanner" | "home" | "tools";

// Scanner Types (Backend-compatible)
export interface ScanResult {
  address: string;
  value: string | number;
  description?: string;
  type: ScanValueType;
}

// YARA scan types
export interface YaraMatch {
  rule_name: string;
  address: number;
  length: number;
  pattern_id: string;
  matched_data: string;
}

export interface YaraScanResponse {
  success: boolean;
  message: string;
  scan_id: string;
  matches: YaraMatch[];
  total_matches: number;
  scanned_bytes: number;
}

export type ScanValueType =
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "int64"
  | "uint64"
  | "float"
  | "double"
  | "string"
  | "bytes"
  | "regex"
  | "ptr";

export interface ScanSettings {
  valueType: ScanValueType;
  scanType: ScanType;
  value: string;
  valueMax?: string; // For range search: max value (value is min)
  valueInputFormat?: "dec" | "hex"; // Input format for integer values (decimal or hexadecimal)
  startAddress?: string;
  endAddress?: string;
  scanMode: "manual" | "regions"; // manual uses start/end addresses, regions uses selected memory regions
  selectedRegions: string[]; // array of region identifiers when scanMode is 'regions'
  alignment: number;
  writable: boolean | null; // true = required, false = excluded, null = don't care
  executable: boolean | null; // true = required, false = excluded, null = don't care
  readable: boolean | null; // true = required, false = excluded, null = don't care
  doSuspend: boolean;
  searchMode: "normal" | "yara" | "ptr"; // Toggle between normal value search, YARA rule search, and pointer scan
  yaraRule?: string; // YARA rule source code
  ptrMaxDepth?: number; // Max depth for pointer scan (default: 5)
  ptrMaxOffset?: number; // Max offset for pointer scan (default: 4096)
  ptrMapFiles?: string[]; // Selected .dptr file names for pointer scan
  ptrMapFilePaths?: { path: string; name: string; targetAddress?: string }[]; // Full paths, names and target addresses for pointer scan files
  ptrMapFileHandles?: File[]; // File handles for the selected .dptr files (legacy browser mode)
}

export type ScanType =
  | "exact"
  | "bigger"
  | "smaller"
  | "range"
  | "greater_or_equal"
  | "less_than"
  | "unknown"
  | "changed"
  | "unchanged"
  | "increased"
  | "decreased";

export interface FilterRequest {
  pattern: string;
  pattern_max?: string; // For range filter: pattern is min, pattern_max is max
  data_type: string;
  scan_id: string;
  filter_method: string;
  return_as_json: boolean;
  do_suspend: boolean;
}

export interface FilterResponse {
  success: boolean;
  message: string;
  filter_id: string;
  scan_id: string;
}

export interface FilterProgressResponse {
  filter_id: string;
  progress_percentage: number;
  processed_results: number;
  total_results: number;
  is_filtering: boolean;
  current_region?: string;
}

export interface ScannerState {
  isScanning: boolean;
  scanResults: ScanResult[];
  scanHistory: ScanResult[][];
  currentScanIndex: number;
  totalResults: number;
  scanSettings: ScanSettings;
  scanId: string;
  scanProgress: number;
  scannedBytes: number;
  totalBytes: number;
  currentRegion?: string;
  searchPatternLength?: number; // Length of the search pattern in bytes (for bytes type)
  errorMessage?: string; // Error message to display to user
  unknownScanId?: string; // Unique ID for unknown scan temp file storage
  unknownScanTempDir?: string; // Temp directory for unknown scan data
}

export interface FunctionData {
  name: string;
  address: string;
  type: string;
  size: string;
  flags: string[];
  scope?: "global" | "local" | "weak";
}

export interface VariableData {
  name: string;
  address: string;
  type: string;
  flags: string[];
  scope?: "global" | "local" | "weak";
}

export interface ModuleData {
  name: string;
  address: string;
  functions: string[];
}

export interface StructureData {
  name: string;
  size: string;
  fields: string[];
}

export interface ChipData {
  label: string;
  color?:
    | "default"
    | "primary"
    | "secondary"
    | "error"
    | "info"
    | "success"
    | "warning";
  variant?: "filled" | "outlined";
}

export interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  divider?: boolean;
}

export interface TreeItemProps {
  children: React.ReactNode;
  details?: string;
  icon?: React.ComponentType<any>;
  color?: string;
  active?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
  chips?: ChipData[];
  contextMenu?: ContextMenuItem[];
}

export interface FunctionTreeItemProps {
  data: FunctionData;
  active: boolean;
  onClick: () => void;
}

export interface SidebarPanelAction {
  icon: React.ReactNode;
  tooltip: string;
  onClick: () => void;
}

export interface SidebarPanelProps {
  title: string;
  icon: React.ComponentType<any>;
  badge?: string;
  actions?: SidebarPanelAction[];
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

// Additional interface definitions for scanner components
export interface RegisterViewData {
  name: string;
  value: string;
  description?: string;
}

// Bookmark interface
// Scan history item for storing search history
export interface ScanHistoryItem {
  id: string;
  valueType: ScanValueType;
  scanType: ScanType;
  value: string;
  description: string;
  timestamp: Date;
  scanSettings: Omit<ScanSettings, "valueType" | "scanType" | "value">;
}

export interface BookmarkItem {
  id: string;
  address: string; // Resolved numeric address (e.g., "0x100120000") or pointer expression (e.g., "BASE+0x100 → [0x10] → [0x18]")
  libraryExpression?: string; // Optional library+offset format (e.g., "UnityFramework + 0x120000")
  value: string;
  type: ScanValueType;
  ptrValueType?: Exclude<ScanValueType, "ptr" | "string" | "bytes" | "regex">; // For ptr type: the underlying value type to read
  size?: number; // Size in bytes for string/bytes types
  description?: string;
  displayFormat?: "dec" | "hex"; // Display format for integer values (also applies to ptr type)
  createdAt: Date;
  tags?: string[];
}

// Watchpoint interface
export interface WatchpointInfo {
  id: string;
  address: string;
  size: number;
  accessType: "r" | "w" | "rw"; // Trigger conditions
  hitCount: number;
  createdAt: Date;
  description?: string;
}

export type WatchpointSize = 1 | 2 | 4 | 8; // Valid sizes for hardware watchpoints
export type WatchpointAccessType = "r" | "w" | "rw";

// Exception information for watchpoint triggers
export interface ExceptionInfo {
  index: number;
  count: number;
  address: string;
  bytecode: string;
  opcode?: string; // Will be populated by disassembly
  timestamp: Date;
  watchpointId?: string;
  thread_id?: number; // Thread ID from exception info
  exception_type?:
    | "breakpoint"
    | "watchpoint"
    | "singlestep"
    | "signal"
    | "sigsegv"
    | "sigbus"
    | "sigfpe"
    | "sigill"
    | "sigabrt"
    | "sigtrap"
    | "unknown"
    | 0
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9
    | 10; // From C++ enum (string or numeric) - 3 is singlestep, 4-10 are signals
  singlestep_mode?: number; // SingleStepMode from server (2 = Breakpoint/Tracing mode)
  memory_address?: number; // Memory address for watchpoint exceptions
  // ARM64 Register values as individual fields (flattened from server processing)
  x0?: string | number;
  x1?: string | number;
  x2?: string | number;
  x3?: string | number;
  x4?: string | number;
  x5?: string | number;
  x6?: string | number;
  x7?: string | number;
  x8?: string | number;
  x9?: string | number;
  x10?: string | number;
  x11?: string | number;
  x12?: string | number;
  x13?: string | number;
  x14?: string | number;
  x15?: string | number;
  x16?: string | number;
  x17?: string | number;
  x18?: string | number;
  x19?: string | number;
  x20?: string | number;
  x21?: string | number;
  x22?: string | number;
  x23?: string | number;
  x24?: string | number;
  x25?: string | number;
  x26?: string | number;
  x27?: string | number;
  x28?: string | number;
  x29?: string | number;
  lr?: string | number;
  fp?: string | number;
  sp?: string | number;
  pc?: string | number;
  cpsr?: string | number;
  // x86_64 Register values
  rax?: string | number;
  rbx?: string | number;
  rcx?: string | number;
  rdx?: string | number;
  rsi?: string | number;
  rdi?: string | number;
  rbp?: string | number;
  rsp?: string | number;
  r8?: string | number;
  r9?: string | number;
  r10?: string | number;
  r11?: string | number;
  r12?: string | number;
  r13?: string | number;
  r14?: string | number;
  r15?: string | number;
  rip?: string | number;
  rflags?: string | number;
  cs?: string | number;
  ss?: string | number;
  ds?: string | number;
  es?: string | number;
  fs?: string | number;
  gs?: string | number;
  instruction?: string; // Added by server processing
}

export interface ExceptionInfoResponse {
  success: boolean;
  exceptions: ExceptionInfo[];
  message?: string;
}

// ObjC Dynamic Analyzer Types
export interface ObjcClassInfo {
  name: string;
  address: string;
  superclass?: string;
  instance_size: number;
  method_count: number;
  ivar_count: number;
  property_count: number;
}

export interface ObjcMethodInfo {
  name: string;
  selector: string;
  implementation: string;
  type_encoding: string;
  is_class_method: boolean;
}

export interface ObjcIvarInfo {
  name: string;
  type_encoding: string;
  offset: number;
}

export interface ObjcPropertyInfo {
  name: string;
  attributes: string;
  getter?: string;
  setter?: string;
}

export interface ObjcProtocolInfo {
  name: string;
}
