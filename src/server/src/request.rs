#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct OpenProcessRequest {
    pub pid: i32,
}

#[derive(Deserialize)]
pub struct ReadMemoryRequest {
    pub address: usize,
    pub size: usize,
    #[serde(default)]
    pub use_ptrace: bool,
}

#[derive(Deserialize)]
pub struct ResolveAddrRequest {
    pub query: String,
}

#[derive(Deserialize)]
pub struct WriteMemoryRequest {
    pub address: usize,
    pub buffer: Vec<u8>,
}

#[derive(Deserialize, Clone)]
pub struct MemoryScanRequest {
    pub pattern: String,
    #[serde(default)]
    pub pattern_max: Option<String>, // For range search: pattern is min, pattern_max is max
    pub address_ranges: Vec<(usize, usize)>,
    pub find_type: String,
    pub data_type: String,
    pub scan_id: String,
    pub align: usize,
    pub return_as_json: bool,
    pub do_suspend: bool,
}

#[derive(Deserialize, Clone)]
pub struct MemoryFilterRequest {
    pub pattern: String,
    #[serde(default)]
    pub pattern_max: Option<String>, // For range filter: pattern is min, pattern_max is max
    pub data_type: String,
    pub scan_id: String,
    pub filter_method: String,
    pub return_as_json: bool,
    pub do_suspend: bool,
}

// YARA memory scan request
#[derive(Deserialize, Clone)]
pub struct YaraScanRequest {
    /// YARA rule source code
    pub rule: String,
    /// Memory address ranges to scan
    pub address_ranges: Vec<(usize, usize)>,
    /// Unique scan identifier
    pub scan_id: String,
    /// Alignment for match addresses (filter results to aligned addresses)
    pub align: usize,
    /// Suspend process during scan
    pub do_suspend: bool,
}

// YARA match result
#[derive(Serialize, Clone)]
pub struct YaraMatch {
    /// Rule identifier that matched
    pub rule_name: String,
    /// Address where match was found
    pub address: usize,
    /// Length of matched data
    pub length: usize,
    /// Pattern identifier within the rule
    pub pattern_id: String,
    /// Matched data as hex string (first 64 bytes max)
    pub matched_data: String,
}

// YARA scan response
#[derive(Serialize)]
pub struct YaraScanResponse {
    pub success: bool,
    pub message: String,
    pub scan_id: String,
    pub matches: Vec<YaraMatch>,
    pub total_matches: usize,
    pub scanned_bytes: u64,
}

#[derive(Deserialize)]
pub struct ExploreDirectoryRequest {
    pub path: String,
    pub max_depth: i32,
}

#[derive(Deserialize)]
pub struct ReadFileRequest {
    pub path: String,
}

#[derive(Deserialize)]
pub struct UploadFileRequest {
    pub path: String,
}

#[derive(Deserialize)]
pub struct SetWatchPointRequest {
    pub address: usize,
    pub size: usize,
    pub _type: String, // "r", "w", "rw", "x", "rx", "wx", "rwx"
}

#[derive(Serialize)]
pub struct SetWatchPointResponse {
    pub success: bool,
    pub message: String,
    pub watchpoint_id: Option<String>, // Added for tracking
}

#[derive(Deserialize)]
pub struct RemoveWatchPointRequest {
    pub address: usize,
}

#[derive(Serialize)]
pub struct RemoveWatchPointResponse {
    pub success: bool,
    pub message: String,
}

// New watchpoint list request/response
#[derive(Deserialize)]
pub struct ListWatchPointsRequest {
    // Empty for now, might add filtering options later
}

#[derive(Serialize)]
pub struct WatchPointInfo {
    pub id: String,
    pub address: usize,
    pub size: usize,
    pub access_type: String, // "r", "w", "rw", "x", "rx", "wx", "rwx"
    pub hit_count: u64,
    pub created_at: String, // ISO 8601 timestamp
    pub description: Option<String>,
}

#[derive(Serialize)]
pub struct ListWatchPointsResponse {
    pub success: bool,
    pub watchpoints: Vec<WatchPointInfo>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct SetBreakPointRequest {
    pub address: usize,
    pub hit_count: i32,
    /// If true, trace results will be written to a file on the server instead of sending to UI
    #[serde(default)]
    pub trace_to_file: bool,
    /// File path for trace output (required if trace_to_file is true)
    #[serde(default)]
    pub trace_file_path: Option<String>,
    /// Optional end address - trace stops when PC reaches this address
    #[serde(default)]
    pub end_address: Option<usize>,
    /// If true, dump initial memory and log all memory accesses during trace
    #[serde(default)]
    pub full_memory_cache: bool,
    /// If true, use software breakpoint instead of hardware breakpoint
    #[serde(default)]
    pub is_software: Option<bool>,
}

#[derive(Serialize)]
pub struct SetBreakPointResponse {
    pub success: bool,
    pub message: String,
    /// If trace_to_file was enabled, this contains the file path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_file_path: Option<String>,
}

#[derive(Deserialize)]
pub struct RemoveBreakPointRequest {
    pub address: usize,
}

#[derive(Serialize)]
pub struct RemoveBreakPointResponse {
    pub success: bool,
    pub message: String,
}

// Software breakpoint original bytes response
#[derive(Serialize)]
pub struct SoftwareBreakpointBytesResponse {
    pub success: bool,
    pub address: usize,
    pub original_bytes: String,
    pub size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// Trace status request/response
#[derive(Serialize)]
pub struct TraceStatusResponse {
    pub success: bool,
    pub enabled: bool,
    pub file_path: Option<String>,
    pub entry_count: u32,
    pub ended_by_end_address: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct ChangeProcessStateRequest {
    pub do_play: bool,
}

#[derive(Serialize)]
pub struct ChangeProcessStateResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct DisassembleRequest {
    pub address: u64,
    pub size: usize,
    pub architecture: String, // "x86_64" or "arm64"
}

#[derive(Deserialize)]
pub struct PointerMapGenerateRequest {
    pub address: u64,
}

#[derive(Deserialize)]
pub struct ScanProgressRequest {
    pub scan_id: String,
}

#[derive(Deserialize)]
pub struct FilterProgressRequest {
    pub filter_id: String,
}

#[derive(Serialize, Clone)]
pub struct ScanProgressResponse {
    pub scan_id: String,
    pub progress_percentage: f64,
    pub scanned_bytes: u64,
    pub total_bytes: u64,
    pub is_scanning: bool,
    pub current_region: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FilterProgressResponse {
    pub filter_id: String,
    pub progress_percentage: f64,
    pub processed_results: u64,
    pub total_results: u64,
    pub is_filtering: bool,
    pub current_region: Option<String>,
}

#[derive(Deserialize)]
pub struct StopScanRequest {
    pub scan_id: String,
}

#[derive(Serialize)]
pub struct StopScanResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct ClearScanRequest {
    pub scan_id: String,
}

#[derive(Serialize)]
pub struct ClearScanResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct ClientVerificationRequest {
    pub encrypted_git_hash: String,
}

#[derive(Serialize)]
pub struct ClientVerificationResponse {
    pub success: bool,
    pub message: String,
    pub server_info: Option<serde_json::Value>,
    pub access_token: Option<String>,
}

// New break state control requests/responses
#[derive(Deserialize)]
pub struct ContinueExecutionRequest {
    #[serde(default)]
    pub thread_id: Option<u64>, // For backward compatibility (single thread)
    #[serde(default)]
    pub thread_ids: Option<Vec<u64>>, // Multiple threads
}

#[derive(Serialize)]
pub struct ContinueExecutionResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<ThreadContinueResult>>, // Details for multiple threads
}

#[derive(Serialize)]
pub struct ThreadContinueResult {
    pub thread_id: u64,
    pub success: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct SingleStepRequest {
    pub thread_id: u64,
}

#[derive(Serialize)]
pub struct SingleStepResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct ReadRegisterRequest {
    pub thread_id: u64,
    pub register_name: String,
}

#[derive(Serialize)]
pub struct ReadRegisterResponse {
    pub success: bool,
    pub register_name: String,
    pub value: Option<u64>,
    pub message: String,
}

#[derive(Deserialize)]
pub struct WriteRegisterRequest {
    pub thread_id: u64,
    pub register_name: String,
    pub value: u64,
}

#[derive(Serialize)]
pub struct WriteRegisterResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct DebugStateRequest {}

#[derive(Serialize)]
pub struct DebugStateResponse {
    pub success: bool,
    pub is_in_break_state: bool,
    pub message: String,
}

#[derive(Deserialize)]
pub struct GetAppIconRequest {
    pub bundle_identifier: String,
}

#[derive(Deserialize)]
pub struct SpawnAppRequest {
    pub bundle_identifier: String,
    #[serde(default)]
    pub suspended: bool,
}

#[derive(Deserialize)]
pub struct TerminateAppRequest {
    pub pid: i32,
}

#[derive(Deserialize)]
pub struct SpawnProcessRequest {
    pub executable_path: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Deserialize)]
pub struct SpawnProcessWithPtyRequest {
    pub executable_path: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Deserialize)]
pub struct PtyWriteRequest {
    pub pty_fd: i32,
    pub data: String,
}

#[derive(Deserialize)]
pub struct PtyResizeRequest {
    pub pty_fd: i32,
    pub rows: i32,
    pub cols: i32,
}

#[derive(Deserialize)]
pub struct ResumeAppRequest {
    pub pid: i32,
}

#[derive(Deserialize)]
pub struct AppRunningStatusRequest {
    pub bundle_identifier: String,
}

/// Script engine type
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScriptEngineType {
    /// Python 3 (default) - RustPython interpreter
    #[default]
    Python,
    /// Rhai scripting language (legacy)
    Rhai,
}

// General-purpose script execution (async)
#[derive(Deserialize)]
pub struct ExecuteScriptRequest {
    /// Script source code
    pub script: String,
    /// Script engine type (default: python)
    #[serde(default)]
    pub engine: ScriptEngineType,
}

/// Response when starting a script execution (async)
#[derive(Serialize)]
pub struct ExecuteScriptResponse {
    pub success: bool,
    /// Job ID for tracking the script execution
    pub job_id: String,
    pub message: String,
}

/// Script execution status
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScriptJobStatus {
    /// Script is queued but not yet running
    Pending,
    /// Script is currently running
    Running,
    /// Script completed successfully
    Completed,
    /// Script failed with an error
    Failed,
    /// Script was cancelled
    Cancelled,
}

/// File upload queued by script
#[derive(Serialize, Clone, Debug)]
pub struct ScriptFileUpload {
    /// Suggested filename
    pub filename: String,
    /// File data as base64
    pub data_base64: String,
    /// MIME type if known
    pub mime_type: Option<String>,
}

/// Response for script status query
#[derive(Serialize)]
pub struct ScriptStatusResponse {
    pub success: bool,
    pub job_id: String,
    pub status: ScriptJobStatus,
    /// Accumulated output so far (new lines since last query)
    pub output: String,
    /// Error message if failed
    pub error: Option<String>,
    /// Whether a trace callback was registered
    pub trace_callback_registered: bool,
    /// Files queued for upload by the script
    pub files: Vec<ScriptFileUpload>,
}

/// Response for script cancellation
#[derive(Serialize)]
pub struct ScriptCancelResponse {
    pub success: bool,
    pub message: String,
}

/// Response for script session disable
#[derive(Serialize)]
pub struct ScriptDisableResponse {
    pub success: bool,
    pub message: String,
}

/// Signal configuration entry (catch/pass behavior)
#[derive(Serialize, Deserialize, Clone)]
pub struct SignalConfigEntry {
    pub signal: i32,
    pub catch_signal: bool,
    pub pass_signal: bool,
}

/// Request for setting a single signal configuration
#[derive(Deserialize)]
pub struct SetSignalConfigRequest {
    pub signal: i32,
    pub catch_signal: bool,
    pub pass_signal: bool,
}

/// Request for setting all signal configurations
#[derive(Deserialize)]
pub struct SetAllSignalConfigsRequest {
    pub configs: Vec<SignalConfigEntry>,
}

/// Response for getting signal configurations
#[derive(Serialize)]
pub struct GetSignalConfigsResponse {
    pub success: bool,
    pub configs: Vec<SignalConfigEntry>,
}

/// Request for removing a signal configuration
#[derive(Deserialize)]
pub struct RemoveSignalConfigRequest {
    pub signal: i32,
}

// PointerMap generation types
#[derive(Serialize, Clone)]
pub struct PointerMapProgressResponse {
    pub task_id: String,
    pub progress_percentage: f64,
    pub current_phase: String,
    pub processed_regions: u64,
    pub total_regions: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub is_generating: bool,
    pub is_complete: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct PointerMapProgressRequest {
    pub task_id: String,
}

#[derive(Serialize, Clone)]
pub struct PointerMapStartResponse {
    pub success: bool,
    pub task_id: String,
    pub message: String,
}
