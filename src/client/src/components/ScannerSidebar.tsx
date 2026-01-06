import React from "react";
import {
  Box,
  Paper,
  Typography,
  Select,
  MenuItem,
  TextField,
  Button,
  FormControl,
  FormControlLabel,
  Checkbox,
  Stack,
  InputLabel,
  Radio,
  RadioGroup,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import { Search, Refresh, TuneRounded } from "@mui/icons-material";
import { borderColors } from "../utils/theme";
import { ScanValueType, ScanType, ScanSettings } from "../types/index";
import { useAppState } from "../hooks/useAppState";

export interface MemoryRegion {
  start_address: string;
  end_address: string;
  size: number;
  protection: string;
  module_name?: string;
  selected?: boolean;
}

const SidebarContainer = styled(Paper)(({ theme }) => ({
  gridArea: "sidebar",
  backgroundColor: theme.palette.background.default,
  borderRight: `1px solid ${borderColors.main}`,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  maxHeight: "100%",
  overflow: "hidden",
}));

//const __SidebarHeader = styled(Box)(({ theme }) => ({
//  padding: theme.spacing(1),
//  borderBottom: `1px solid ${borderColors.main}`,
//  backgroundColor: theme.palette.background.paper,
//}));>

const SidebarContent = styled(Box)(({ theme }) => ({
  flex: 1,
  padding: theme.spacing(1),
  display: "flex",
  flexDirection: "column",
  gap: theme.spacing(0.5),
  overflow: "auto",
}));

const ScanSection = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.spacing(0.25),
  marginBottom: theme.spacing(1),
  backgroundColor: "transparent",
}));

const ScanSectionHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  padding: "4px 8px",
  backgroundColor: "#252526",
  borderRadius: "4px",
}));

const ScanSectionContent = styled(Box)(() => ({
  padding: "4px 8px 0 8px",
}));

const ScanControls = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.spacing(0.5),
}));

// Responsive form controls
const ResponsiveFormControl = styled(FormControl)(() => ({
  "@media (max-height: 800px)": {
    "& .MuiInputBase-root": {
      minHeight: "20px", // Half of normal height
      fontSize: "11px",
    },
    "& .MuiSelect-select": {
      paddingTop: "4px",
      paddingBottom: "4px",
    },
    "& .MuiInputLabel-root": {
      fontSize: "11px",
    },
  },
}));

const ResponsiveTextField = styled(TextField)(() => ({
  "@media (max-height: 800px)": {
    "& .MuiInputBase-root": {
      minHeight: "20px", // Half of normal height
      fontSize: "11px",
    },
    "& .MuiInputBase-input": {
      paddingTop: "4px",
      paddingBottom: "4px",
    },
    "& .MuiInputLabel-root": {
      fontSize: "11px",
    },
  },
}));

const ResponsiveButton = styled(Button)(() => ({
  "@media (max-height: 800px)": {
    minHeight: "24px", // Half of normal height
    fontSize: "10px",
    padding: "2px 8px",
  },
}));

const ResponsiveTypography = styled(Typography)(() => ({
  "@media (max-height: 800px)": {
    fontSize: "9px !important", // Half of the normal font size
  },
}));

const ResponsiveFormControlLabel = styled(FormControlLabel)(() => ({
  "@media (max-height: 800px)": {
    "& .MuiFormControlLabel-label": {
      fontSize: "9px",
    },
    "& .MuiCheckbox-root": {
      padding: "2px",
    },
    margin: "0 !important",
    minWidth: "auto",
  },
}));

const ResponsiveBox = styled(Box)(() => ({
  "@media (max-height: 800px)": {
    gap: "4px !important", // Reduced gap between elements
  },
}));

interface ScannerSidebarProps {
  // Legacy props for backward compatibility
  memoryRegionsLoaded?: boolean;
  onScanSettingsChange?: (settings: ScanSettings) => boolean;
  onFirstScan?: () => void;
  onNextScan?: () => void;
  onNewScan?: () => void;
  onClearScan?: () => void;
}

export const ScannerSidebar: React.FC<ScannerSidebarProps> = ({
  memoryRegionsLoaded: propsMemoryRegionsLoaded,
  onScanSettingsChange,
  onFirstScan,
  onNextScan,
  onNewScan,
  onClearScan,
}) => {
  // Use global app state
  const { ui, uiActions } = useAppState();
  const rawScanSettings = ui.scannerState.scanSettings;

  // デフォルト値で補完したスキャン設定を作成
  const defaultScanSettings = {
    valueType: "int32" as ScanValueType,
    scanType: "exact" as ScanType,
    value: "",
    valueMax: "", // For range search
    startAddress: "",
    endAddress: "",
    scanMode: "manual" as "manual" | "regions",
    selectedRegions: [],
    alignment: 4,
    writable: null as boolean | null,
    executable: null as boolean | null,
    readable: null as boolean | null,
    doSuspend: false,
  };

  const scanSettings = { ...defaultScanSettings, ...rawScanSettings };
  const isScanning = ui.scannerState.isScanning;
  const scanResults = ui.scannerState.totalResults;
  const canNextScan = ui.scannerState.scanResults.length > 0 && !isScanning;

  // Filter時（スキャン結果がある場合）は、Scan TypeとValue以外の設定をロック
  const isFilterMode = ui.scannerState.scanResults.length > 0;
  const isSettingsLocked = isScanning || isFilterMode;

  // Use props if provided (legacy support), otherwise use empty defaults
  const memoryRegionsLoaded = propsMemoryRegionsLoaded ?? true;
  const handleSettingChange = <K extends keyof ScanSettings>(
    key: K,
    value: ScanSettings[K]
  ) => {
    const newSettings = { ...scanSettings, [key]: value };
    // Update UI state
    uiActions.setScanSettings(newSettings);
    // Call legacy callback if provided - cast to proper type
    onScanSettingsChange?.(newSettings as ScanSettings);
  };

  const valueTypes = [
    { value: "int8", label: "Int8 (1 byte)" },
    { value: "uint8", label: "UInt8 (1 byte)" },
    { value: "int16", label: "Int16 (2 bytes)" },
    { value: "uint16", label: "UInt16 (2 bytes)" },
    { value: "int32", label: "Int32 (4 bytes)" },
    { value: "uint32", label: "UInt32 (4 bytes)" },
    { value: "int64", label: "Int64 (8 bytes)" },
    { value: "uint64", label: "UInt64 (8 bytes)" },
    { value: "float", label: "Float (4 bytes)" },
    { value: "double", label: "Double (8 bytes)" },
    { value: "string", label: "String" },
    { value: "bytes", label: "Array of Bytes" },
    { value: "regex", label: "Regex" },
  ];

  // string/bytes/regex型の場合、増減比較は意味がないため非表示にする
  const isStringOrBytesOrRegex =
    scanSettings.valueType === "string" ||
    scanSettings.valueType === "bytes" ||
    scanSettings.valueType === "regex";

  // Check if value type is an integer type (supports hex input)
  const isIntegerType = [
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "int64",
    "uint64",
  ].includes(scanSettings.valueType);

  // Check if value type supports range search (numeric types only)
  const supportsRangeSearch = [
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "int64",
    "uint64",
    "float",
    "double",
  ].includes(scanSettings.valueType);

  const scanTypes: { value: ScanType; label: string; disabled?: boolean }[] = [
    { value: "exact", label: "Exact Value" },
    // Range search only for numeric types
    ...(supportsRangeSearch
      ? [
          { value: "range" as ScanType, label: "Value between..." },
          {
            value: "greater_or_equal" as ScanType,
            label: "Greater than or equal...",
          },
          { value: "less_than" as ScanType, label: "Less than..." },
        ]
      : []),
    // Unknown value search only for numeric types (first scan only)
    ...(supportsRangeSearch && !canNextScan && false
      ? [{ value: "unknown" as ScanType, label: "Unknown initial value" }]
      : []),
    { value: "changed", label: "Changed value", disabled: !canNextScan },
    { value: "unchanged", label: "Unchanged value", disabled: !canNextScan },
    // increased/decreased are hidden for string/bytes/regex types
    ...(isStringOrBytesOrRegex
      ? []
      : [
          {
            value: "increased" as ScanType,
            label: "Increased value",
            disabled: !canNextScan,
          },
          {
            value: "decreased" as ScanType,
            label: "Decreased value",
            disabled: !canNextScan,
          },
        ]),
  ];

  const needsValue = [
    "exact",
    "bigger",
    "smaller",
    "range",
    "greater_or_equal",
    "less_than",
  ].includes(scanSettings.scanType);

  // Check if range search is selected
  const isRangeSearch = scanSettings.scanType === "range";

  // Unknown and comparison types don't need value input
  const isComparisonType = [
    "unknown",
    "changed",
    "unchanged",
    "increased",
    "decreased",
  ].includes(scanSettings.scanType);

  return (
    <SidebarContainer elevation={0}>
      {/* Settings Header */}
      <Box
        sx={{
          p: 1,
          borderBottom: "1px solid #3e3e42",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 0.5,
          }}
        >
          <TuneRounded sx={{ fontSize: 16, color: "text.secondary" }} />
          <Typography
            variant="subtitle1"
            sx={{
              fontSize: "13px",
              fontWeight: 600,
              color: "text.primary",
            }}
          >
            Settings
          </Typography>
        </Box>
      </Box>
      <SidebarContent>
        {/* Value Type Selection */}
        <ScanSection>
          <ScanSectionHeader>
            <ResponsiveTypography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                fontSize: "10px",
                color: "#4fc1ff",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Value Type
            </ResponsiveTypography>
          </ScanSectionHeader>
          <ScanSectionContent>
            <ResponsiveFormControl fullWidth size="small">
              <Select
                value={scanSettings.valueType || "int32"}
                disabled={isSettingsLocked}
                onChange={(e) =>
                  handleSettingChange(
                    "valueType",
                    e.target.value as ScanValueType
                  )
                }
              >
                {valueTypes.map((type) => (
                  <MenuItem key={type.value} value={type.value}>
                    {type.label}
                  </MenuItem>
                ))}
              </Select>
            </ResponsiveFormControl>
          </ScanSectionContent>
        </ScanSection>

        {/* Scan Type Selection */}
        <ScanSection>
          <ScanSectionHeader>
            <ResponsiveTypography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                fontSize: "10px",
                color: "#4fc1ff",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Scan Type
            </ResponsiveTypography>
          </ScanSectionHeader>
          <ScanSectionContent>
            <ResponsiveFormControl fullWidth size="small">
              <Select
                value={scanSettings.scanType || "exact"}
                onChange={(e) =>
                  handleSettingChange("scanType", e.target.value as ScanType)
                }
              >
                {scanTypes.map((type) => (
                  <MenuItem
                    key={type.value}
                    value={type.value}
                    disabled={type.disabled}
                  >
                    {type.label}
                  </MenuItem>
                ))}
              </Select>
            </ResponsiveFormControl>
          </ScanSectionContent>
        </ScanSection>

        {/* Value Input */}
        {(needsValue || isComparisonType) && (
          <ScanSection>
            <ScanSectionHeader>
              <ResponsiveTypography
                variant="subtitle2"
                sx={{
                  fontWeight: 600,
                  fontSize: "10px",
                  color: "#4fc1ff",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                Value
              </ResponsiveTypography>
            </ScanSectionHeader>
            <ScanSectionContent>
              <Stack spacing={0.5}>
                {/* Range search: Min value label */}
                {isRangeSearch && (
                  <ResponsiveTypography
                    variant="caption"
                    sx={{
                      fontSize: "9px",
                      color: "#9cdcfe",
                      textTransform: "uppercase",
                      letterSpacing: "0.3px",
                    }}
                  >
                    Min Value
                  </ResponsiveTypography>
                )}
                <ResponsiveTextField
                  fullWidth
                  size="small"
                  value={scanSettings.value || ""}
                  disabled={isComparisonType}
                  onChange={(e) => handleSettingChange("value", e.target.value)}
                  placeholder={
                    isComparisonType
                      ? "Not required"
                      : isRangeSearch
                        ? isIntegerType
                          ? scanSettings.valueInputFormat === "hex"
                            ? "Min (0x1A2B)"
                            : "Min value"
                          : "Min value"
                        : scanSettings.valueType === "string"
                          ? "Enter text..."
                          : scanSettings.valueType === "bytes"
                            ? "11 22 33"
                            : isIntegerType
                              ? scanSettings.valueInputFormat === "hex"
                                ? "0x1A2B or 1A2B"
                                : "Enter decimal value..."
                              : "Enter value..."
                  }
                  sx={{
                    "& .MuiInputBase-root": {
                      backgroundColor: "#1e1e1e",
                      fontSize: "14px",
                    },
                    "& .MuiInputBase-input": {
                      py: 1,
                    },
                    "@media (max-height: 800px)": {
                      "& .MuiInputBase-root": {
                        fontSize: "11px",
                      },
                      "& .MuiInputBase-input": {
                        py: 0.5,
                      },
                    },
                  }}
                />
                {/* Range search: Max value input */}
                {isRangeSearch && (
                  <>
                    <ResponsiveTypography
                      variant="caption"
                      sx={{
                        fontSize: "9px",
                        color: "#9cdcfe",
                        textTransform: "uppercase",
                        letterSpacing: "0.3px",
                        mt: 0.5,
                      }}
                    >
                      Max Value
                    </ResponsiveTypography>
                    <ResponsiveTextField
                      fullWidth
                      size="small"
                      value={scanSettings.valueMax || ""}
                      onChange={(e) =>
                        handleSettingChange("valueMax", e.target.value)
                      }
                      placeholder={
                        isIntegerType
                          ? scanSettings.valueInputFormat === "hex"
                            ? "Max (0x1A2B)"
                            : "Max value"
                          : "Max value"
                      }
                      sx={{
                        "& .MuiInputBase-root": {
                          backgroundColor: "#1e1e1e",
                          fontSize: "14px",
                        },
                        "& .MuiInputBase-input": {
                          py: 1,
                        },
                        "@media (max-height: 800px)": {
                          "& .MuiInputBase-root": {
                            fontSize: "11px",
                          },
                          "& .MuiInputBase-input": {
                            py: 0.5,
                          },
                        },
                      }}
                    />
                  </>
                )}
                {/* Hex/Dec toggle for integer types */}
                {isIntegerType && !isComparisonType && (
                  <RadioGroup
                    row
                    value={scanSettings.valueInputFormat || "dec"}
                    onChange={(e) =>
                      handleSettingChange(
                        "valueInputFormat",
                        e.target.value as "dec" | "hex"
                      )
                    }
                    sx={{
                      gap: 1,
                      "@media (max-height: 800px)": {
                        gap: 0.5,
                      },
                    }}
                  >
                    <FormControlLabel
                      value="dec"
                      control={
                        <Radio
                          size="small"
                          sx={{
                            padding: "2px",
                            "& .MuiSvgIcon-root": { fontSize: "14px" },
                            "@media (max-height: 800px)": {
                              padding: "1px",
                              "& .MuiSvgIcon-root": { fontSize: "12px" },
                            },
                          }}
                        />
                      }
                      label="Dec"
                      sx={{
                        margin: 0,
                        "& .MuiTypography-root": {
                          fontSize: "11px",
                          color: "#9cdcfe",
                        },
                        "@media (max-height: 800px)": {
                          "& .MuiTypography-root": {
                            fontSize: "9px",
                          },
                        },
                      }}
                    />
                    <FormControlLabel
                      value="hex"
                      control={
                        <Radio
                          size="small"
                          sx={{
                            padding: "2px",
                            "& .MuiSvgIcon-root": { fontSize: "14px" },
                            "@media (max-height: 800px)": {
                              padding: "1px",
                              "& .MuiSvgIcon-root": { fontSize: "12px" },
                            },
                          }}
                        />
                      }
                      label="Hex"
                      sx={{
                        margin: 0,
                        "& .MuiTypography-root": {
                          fontSize: "11px",
                          color: "#9cdcfe",
                        },
                        "@media (max-height: 800px)": {
                          "& .MuiTypography-root": {
                            fontSize: "9px",
                          },
                        },
                      }}
                    />
                  </RadioGroup>
                )}
              </Stack>
            </ScanSectionContent>
          </ScanSection>
        )}

        {/* Memory Range */}
        <ScanSection>
          <ScanSectionHeader>
            <ResponsiveTypography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                fontSize: "10px",
                color: "#4fc1ff",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Memory Range
            </ResponsiveTypography>
          </ScanSectionHeader>
          <ScanSectionContent>
            <Stack spacing={0.75}>
              <ResponsiveTextField
                fullWidth
                size="small"
                label="Start Address"
                value={scanSettings.startAddress || ""}
                disabled={isSettingsLocked}
                onChange={(e) =>
                  handleSettingChange("startAddress", e.target.value)
                }
                placeholder="0x0"
              />
              <ResponsiveTextField
                fullWidth
                size="small"
                label="End Address"
                value={scanSettings.endAddress || ""}
                disabled={isSettingsLocked}
                onChange={(e) =>
                  handleSettingChange("endAddress", e.target.value)
                }
                placeholder="0x7FFFFFFFFFFF"
              />
            </Stack>
          </ScanSectionContent>
        </ScanSection>

        {/* Memory Protection */}
        <ScanSection>
          <ScanSectionHeader>
            <ResponsiveTypography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                fontSize: "10px",
                color: "#4fc1ff",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Protection
            </ResponsiveTypography>
          </ScanSectionHeader>
          <ScanSectionContent>
            <ResponsiveBox
              sx={{ display: "flex", flexDirection: "row", gap: 2 }}
            >
              <ResponsiveFormControlLabel
                control={
                  <Checkbox
                    checked={scanSettings.readable === true}
                    indeterminate={scanSettings.readable === null}
                    disabled={isSettingsLocked}
                    onChange={() => {
                      // 3段階サイクル: false → true → null → false
                      const currentValue = scanSettings.readable;
                      if (currentValue === false) {
                        handleSettingChange("readable", true);
                      } else if (currentValue === true) {
                        handleSettingChange("readable", null);
                      } else {
                        handleSettingChange("readable", false);
                      }
                    }}
                    size="small"
                  />
                }
                label={
                  <ResponsiveTypography variant="caption">
                    Read
                  </ResponsiveTypography>
                }
                sx={{ margin: 0, minWidth: 0 }}
              />
              <ResponsiveFormControlLabel
                control={
                  <Checkbox
                    checked={scanSettings.writable === true}
                    indeterminate={scanSettings.writable === null}
                    disabled={isSettingsLocked}
                    onChange={() => {
                      // 3段階サイクル: false → true → null → false
                      const currentValue = scanSettings.writable;
                      if (currentValue === false) {
                        handleSettingChange("writable", true);
                      } else if (currentValue === true) {
                        handleSettingChange("writable", null);
                      } else {
                        handleSettingChange("writable", false);
                      }
                    }}
                    size="small"
                  />
                }
                label={
                  <ResponsiveTypography variant="caption">
                    Write
                  </ResponsiveTypography>
                }
                sx={{ margin: 0, minWidth: 0 }}
              />
              <ResponsiveFormControlLabel
                control={
                  <Checkbox
                    checked={scanSettings.executable === true}
                    indeterminate={scanSettings.executable === null}
                    disabled={isSettingsLocked}
                    onChange={() => {
                      // 3段階サイクル: false → true → null → false
                      const currentValue = scanSettings.executable;
                      if (currentValue === false) {
                        handleSettingChange("executable", true);
                      } else if (currentValue === true) {
                        handleSettingChange("executable", null);
                      } else {
                        handleSettingChange("executable", false);
                      }
                    }}
                    size="small"
                  />
                }
                label={
                  <ResponsiveTypography variant="caption">
                    Execute
                  </ResponsiveTypography>
                }
                sx={{ margin: 0, minWidth: 0 }}
              />
            </ResponsiveBox>
          </ScanSectionContent>
        </ScanSection>

        {/* Setting */}
        <ScanSection>
          <ScanSectionHeader>
            <ResponsiveTypography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                fontSize: "10px",
                color: "#4fc1ff",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Setting
            </ResponsiveTypography>
          </ScanSectionHeader>
          <ScanSectionContent>
            <ResponsiveFormControl fullWidth size="small">
              <InputLabel id="alignment-label">Alignment</InputLabel>
              <Select
                labelId="alignment-label"
                label="Alignment"
                value={scanSettings.alignment || 4}
                disabled={isSettingsLocked}
                onChange={(e) =>
                  handleSettingChange("alignment", Number(e.target.value))
                }
              >
                <MenuItem value={1}>1 (No alignment)</MenuItem>
                <MenuItem value={2}>2 bytes</MenuItem>
                <MenuItem value={4}>4 bytes</MenuItem>
                <MenuItem value={8}>8 bytes</MenuItem>
                <MenuItem value={16}>16 bytes</MenuItem>
              </Select>
            </ResponsiveFormControl>
          </ScanSectionContent>
        </ScanSection>

        {/* Scan Controls */}
        <ScanControls>
          <ResponsiveButton
            fullWidth
            variant={scanResults > 0 ? "outlined" : "contained"}
            startIcon={<Search />}
            onClick={() => onFirstScan?.()}
            disabled={
              isScanning ||
              scanResults > 0 || // Disable if any results exist (after lookup)
              (needsValue &&
                !(scanSettings.value || "").trim() &&
                !isComparisonType) || // Only require value for non-comparison types
              (scanSettings.scanMode === "regions" && !memoryRegionsLoaded)
            }
            color="primary"
          >
            Look Up
          </ResponsiveButton>

          <ResponsiveButton
            fullWidth
            variant={scanResults > 0 ? "contained" : "outlined"}
            startIcon={<Search />}
            onClick={() => onNextScan?.()}
            disabled={
              isScanning ||
              !canNextScan ||
              (needsValue &&
                !(scanSettings.value || "").trim() &&
                !isComparisonType) // Allow comparison types without value
            }
            color={scanResults > 0 ? "secondary" : "primary"}
          >
            Filter
          </ResponsiveButton>

          <ResponsiveButton
            fullWidth
            variant="text"
            startIcon={<Refresh />}
            onClick={() => {
              // Reset settings to defaults
              uiActions.setScanSettings({
                valueType: "int32",
                scanType: "exact",
                value: "",
                startAddress: "0x0",
                endAddress: "0x7FFFFFFFFFFF",
                scanMode: "manual",
                selectedRegions: [],
                alignment: 4,
                writable: true,
                executable: false,
                readable: true,
                doSuspend: false,
              });
              onClearScan?.();
              onNewScan?.();
            }}
            disabled={isScanning}
          >
            Clear
          </ResponsiveButton>
        </ScanControls>
      </SidebarContent>
    </SidebarContainer>
  );
};
