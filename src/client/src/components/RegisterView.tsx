import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Box,
  Typography,
  TextField,
  IconButton,
  Tooltip,
  Snackbar,
  Alert,
  Menu,
  MenuItem,
  styled,
} from "@mui/material";
import {
  Check,
  Close,
  Refresh,
  Memory,
  OpenInNew,
  ContentCopy,
} from "@mui/icons-material";
import { getApiClient } from "../lib/api";
import { useAppState } from "../hooks/useAppState";
import { useLocalStorage } from "../hooks/useLocalStorage";

// Vertical resizer styled component for left edge
const VerticalResizer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  width: "4px",
  height: "100%",
  backgroundColor: isResizing ? "#4fc1ff" : "transparent",
  cursor: "ew-resize",
  position: "absolute",
  left: 0,
  top: 0,
  transition: "background-color 0.15s ease",
  zIndex: 20,
  "&:hover": {
    backgroundColor: "#4fc1ff",
  },
  "&::before": {
    content: '""',
    position: "absolute",
    top: 0,
    left: "-2px",
    width: "8px",
    height: "100%",
  },
}));

interface RegisterViewProps {
  open: boolean;
  registerData?: Record<string, string>; // Register values from exception data
  isInBreakState?: boolean;
  currentThreadId?: number | null; // Current active thread for register operations
  onWidthChange?: (width: number) => void; // Callback when width changes
}

interface Register {
  name: string;
  value: string;
  type: "general" | "special";
  editable?: boolean;
}

// Format hex value to uppercase (0x000abc -> 0x000ABC)
const formatHexValue = (value: string): string => {
  if (!value) return value;
  // Check if it starts with 0x or 0X
  if (value.toLowerCase().startsWith("0x")) {
    return "0x" + value.slice(2).toUpperCase();
  }
  return value.toUpperCase();
};

export const RegisterView: React.FC<RegisterViewProps> = ({
  open,
  registerData = {},
  isInBreakState = false,
  currentThreadId, // Extract currentThreadId from props
  onWidthChange,
}) => {
  const { uiActions, system } = useAppState();
  const { serverInfo } = system;
  const [registers, setRegisters] = useState<Register[]>([]);
  const [editingRegister, setEditingRegister] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [previousRegisterData, setPreviousRegisterData] = useState<
    Record<string, string>
  >({});
  const [changedRegisters, setChangedRegisters] = useState<Set<string>>(
    new Set()
  );
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error" | "info";
  }>({ open: false, message: "", severity: "info" });

  // Resizable width state with localStorage persistence
  const [panelWidth, setPanelWidth] = useLocalStorage<number>(
    "register-view-width",
    300
  );
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartWidthRef = useRef<number>(0);

  // Handle resize mouse down
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = panelWidth;
    },
    [panelWidth]
  );

  // Handle resize mouse move and mouse up
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Since resizer is on left edge, moving left increases width
      const deltaX = resizeStartXRef.current - e.clientX;
      const newWidth = Math.max(
        200,
        Math.min(600, resizeStartWidthRef.current + deltaX)
      );
      setPanelWidth(newWidth);
      // Notify parent about width change for grid update
      if (onWidthChange) {
        onWidthChange(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, setPanelWidth, onWidthChange]);

  // Ref to track thread switching - skip change detection during thread switch
  const isThreadSwitchingRef = useRef(false);
  const previousThreadIdRef = useRef<number | null | undefined>(
    currentThreadId
  );

  const apiClient = getApiClient();

  // Detect architecture based on register data or serverInfo
  const detectArchitecture = useCallback((): "arm64" | "x86_64" => {
    const keys = Object.keys(registerData);
    const keysLower = keys.map((k) => k.toLowerCase());

    // Check for x86_64 specific registers in registerData
    if (
      keysLower.includes("rax") ||
      keysLower.includes("rip") ||
      keysLower.includes("rbx") ||
      keysLower.includes("rcx")
    ) {
      console.log(
        "[RegisterView] Detected x86_64 architecture from register keys:",
        keys.slice(0, 5)
      );
      return "x86_64";
    }
    // Check for ARM64 specific registers in registerData
    if (
      keysLower.includes("x0") ||
      keysLower.includes("cpsr") ||
      keysLower.includes("x1")
    ) {
      console.log(
        "[RegisterView] Detected ARM64 architecture from register keys:",
        keys.slice(0, 5)
      );
      return "arm64";
    }

    // Fallback: use serverInfo.arch if registerData is empty or inconclusive
    if (serverInfo?.arch) {
      const arch = serverInfo.arch.toLowerCase();
      if (arch === "x86_64" || arch === "amd64" || arch === "x64") {
        console.log(
          "[RegisterView] Using x86_64 architecture from serverInfo:",
          serverInfo.arch
        );
        return "x86_64";
      }
      if (arch === "arm64" || arch === "aarch64") {
        console.log(
          "[RegisterView] Using ARM64 architecture from serverInfo:",
          serverInfo.arch
        );
        return "arm64";
      }
    }

    // Default to arm64 if can't determine
    console.log(
      "[RegisterView] Could not detect architecture, keys:",
      keys,
      "serverInfo:",
      serverInfo?.arch,
      "defaulting to arm64"
    );
    return "arm64";
  }, [registerData, serverInfo]);

  // Initialize registers with both static and dynamic data
  const initializeRegisters = useCallback(() => {
    const startTime = performance.now();
    const arch = detectArchitecture();
    console.log(
      "[RegisterView] Initializing registers for architecture:",
      arch,
      "registerData keys:",
      Object.keys(registerData),
      `time: ${new Date().toISOString()}`
    );

    let baseRegisters: Register[];

    if (arch === "x86_64") {
      // x86_64 registers
      baseRegisters = [
        // General Purpose Registers
        {
          name: "RAX",
          value:
            registerData["rax"] || registerData["RAX"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RBX",
          value:
            registerData["rbx"] || registerData["RBX"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RCX",
          value:
            registerData["rcx"] || registerData["RCX"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RDX",
          value:
            registerData["rdx"] || registerData["RDX"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RSI",
          value:
            registerData["rsi"] || registerData["RSI"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RDI",
          value:
            registerData["rdi"] || registerData["RDI"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RBP",
          value:
            registerData["rbp"] || registerData["RBP"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "RSP",
          value:
            registerData["rsp"] || registerData["RSP"] || "0x0000000000000000",
          type: "special",
          editable: true,
        },
        {
          name: "R8",
          value:
            registerData["r8"] || registerData["R8"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R9",
          value:
            registerData["r9"] || registerData["R9"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R10",
          value:
            registerData["r10"] || registerData["R10"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R11",
          value:
            registerData["r11"] || registerData["R11"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R12",
          value:
            registerData["r12"] || registerData["R12"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R13",
          value:
            registerData["r13"] || registerData["R13"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R14",
          value:
            registerData["r14"] || registerData["R14"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        {
          name: "R15",
          value:
            registerData["r15"] || registerData["R15"] || "0x0000000000000000",
          type: "general",
          editable: true,
        },
        // Special Registers
        {
          name: "RIP",
          value:
            registerData["rip"] || registerData["RIP"] || "0x0000000000000000",
          type: "special",
          editable: true,
        },
        {
          name: "RFLAGS",
          value:
            registerData["rflags"] ||
            registerData["RFLAGS"] ||
            "0x0000000000000000",
          type: "special",
          editable: true,
        },
        // Segment Registers
        {
          name: "CS",
          value: registerData["cs"] || registerData["CS"] || "0x0000",
          type: "special",
          editable: false,
        },
        {
          name: "SS",
          value: registerData["ss"] || registerData["SS"] || "0x0000",
          type: "special",
          editable: false,
        },
        {
          name: "DS",
          value: registerData["ds"] || registerData["DS"] || "0x0000",
          type: "special",
          editable: false,
        },
        {
          name: "ES",
          value: registerData["es"] || registerData["ES"] || "0x0000",
          type: "special",
          editable: false,
        },
        {
          name: "FS",
          value: registerData["fs"] || registerData["FS"] || "0x0000",
          type: "special",
          editable: false,
        },
        {
          name: "GS",
          value: registerData["gs"] || registerData["GS"] || "0x0000",
          type: "special",
          editable: false,
        },
      ];
    } else {
      // ARM64 registers
      baseRegisters = [
        // ARM64 General Purpose Registers (X0-X29)
        ...Array.from({ length: 30 }, (_, i) => ({
          name: `X${i}`,
          value:
            registerData[`x${i}`] ||
            registerData[`X${i}`] ||
            "0x0000000000000000",
          type: "general" as const,
          editable: true,
        })),
        // Special Registers
        {
          name: "SP",
          value:
            registerData["sp"] || registerData["SP"] || "0x00007FF7BFEFF000",
          type: "special",
          editable: true,
        },
        {
          name: "PC",
          value:
            registerData["pc"] || registerData["PC"] || "0x0000000100001000",
          type: "special",
          editable: true,
        },
        {
          name: "LR",
          value:
            registerData["lr"] || registerData["LR"] || "0x0000000100001020",
          type: "special",
          editable: true,
        },
        {
          name: "FP",
          value:
            registerData["fp"] || registerData["FP"] || "0x00007FF7BFEFEFE0",
          type: "special",
          editable: true,
        },
        {
          name: "CPSR",
          value: registerData["cpsr"] || registerData["CPSR"] || "0x60000000",
          type: "special",
          editable: true,
        },
      ];
    }

    // Format all register values to uppercase hex
    const formattedRegisters = baseRegisters.map((reg) => ({
      ...reg,
      value: formatHexValue(reg.value),
    }));
    setRegisters(formattedRegisters);
    console.log(
      `[RegisterView] initializeRegisters completed in ${(performance.now() - startTime).toFixed(2)}ms at ${new Date().toISOString()}`
    );
  }, [registerData, detectArchitecture]);

  useEffect(() => {
    initializeRegisters();
  }, [initializeRegisters]);

  // Reset previous register data when thread changes (to avoid highlighting all registers)
  useEffect(() => {
    // Detect thread switch
    if (previousThreadIdRef.current !== currentThreadId) {
      console.log(
        `[RegisterView] Thread switched from ${previousThreadIdRef.current} to ${currentThreadId}, disabling change detection temporarily`
      );
      // Set flag to skip change detection for the next registerData update
      isThreadSwitchingRef.current = true;
      previousThreadIdRef.current = currentThreadId;
    }

    if (currentThreadId !== undefined && currentThreadId !== null) {
      console.log(
        `[RegisterView] Thread changed to ${currentThreadId}, resetting previous register data`
      );
      // Reset to current register data so no registers appear as "changed"
      setPreviousRegisterData(
        Object.keys(registerData).reduce(
          (acc, key) => {
            acc[key.toLowerCase()] = registerData[key];
            return acc;
          },
          {} as Record<string, string>
        )
      );
      setChangedRegisters(new Set());
    }
  }, [currentThreadId]); // Only depend on currentThreadId, not registerData

  // Detect changed registers separately
  useEffect(() => {
    // Skip change detection during thread switching
    if (isThreadSwitchingRef.current) {
      console.log(
        `[RegisterView] Skipping change detection due to thread switch`
      );
      isThreadSwitchingRef.current = false;
      // Update previous register data without highlighting changes
      setPreviousRegisterData(
        Object.keys(registerData).reduce(
          (acc, key) => {
            acc[key.toLowerCase()] = registerData[key];
            return acc;
          },
          {} as Record<string, string>
        )
      );
      return;
    }

    // Skip if previousRegisterData is empty (first render)
    if (Object.keys(previousRegisterData).length === 0) {
      setPreviousRegisterData(
        Object.keys(registerData).reduce(
          (acc, key) => {
            acc[key.toLowerCase()] = registerData[key];
            return acc;
          },
          {} as Record<string, string>
        )
      );
      return;
    }

    const newChangedRegisters = new Set<string>();
    Object.keys(registerData).forEach((key) => {
      const normalizedKey = key.toLowerCase();
      const prevValue = previousRegisterData[normalizedKey];
      const currentValue = registerData[key];

      if (prevValue && prevValue !== currentValue) {
        newChangedRegisters.add(normalizedKey);
        console.log(`[RegisterView] Register ${normalizedKey} changed:`, {
          prev: prevValue,
          current: currentValue,
        });
      }
    });

    setChangedRegisters(newChangedRegisters);
    setPreviousRegisterData(
      Object.keys(registerData).reduce(
        (acc, key) => {
          acc[key.toLowerCase()] = registerData[key];
          return acc;
        },
        {} as Record<string, string>
      )
    );

    // Clear changed registers after 3 seconds
    if (newChangedRegisters.size > 0) {
      const timer = setTimeout(() => {
        setChangedRegisters(new Set());
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [registerData]);

  // Load register values from server when in break state
  const loadRegisterValues = useCallback(async () => {
    if (!isInBreakState) return;

    try {
      const arch = detectArchitecture();
      const registerNames =
        arch === "x86_64"
          ? [
              // x86_64 registers
              "rax",
              "rbx",
              "rcx",
              "rdx",
              "rsi",
              "rdi",
              "rbp",
              "rsp",
              "r8",
              "r9",
              "r10",
              "r11",
              "r12",
              "r13",
              "r14",
              "r15",
              "rip",
              "rflags",
              "cs",
              "ss",
              "ds",
              "es",
              "fs",
              "gs",
            ]
          : [
              // ARM64 registers
              "pc",
              "lr",
              "fp",
              "sp",
              "cpsr",
              ...Array.from({ length: 30 }, (_, i) => `x${i}`),
            ];
      const updatedRegisters = [...registers];

      for (const regName of registerNames) {
        try {
          const response = await apiClient.readRegister(
            regName,
            currentThreadId || undefined
          );
          if (response.success && response.value !== undefined) {
            const regIndex = updatedRegisters.findIndex(
              (r) => r.name.toLowerCase() === regName.toLowerCase()
            );
            if (regIndex >= 0) {
              // Use appropriate padding based on architecture and register type
              const isSegmentReg = [
                "cs",
                "ss",
                "ds",
                "es",
                "fs",
                "gs",
              ].includes(regName.toLowerCase());
              const padLength = isSegmentReg ? 4 : 16;
              updatedRegisters[regIndex].value =
                `0x${response.value.toString(16).padStart(padLength, "0").toUpperCase()}`;
            }
          }
        } catch (error) {
          console.error(`Failed to read register ${regName}:`, error);
        }
      }

      setRegisters(updatedRegisters);
    } catch (error) {
      console.error("Failed to load register values:", error);
      setSnackbar({
        open: true,
        message: "Failed to load register values",
        severity: "error",
      });
    }
  }, [
    isInBreakState,
    registers,
    apiClient,
    currentThreadId,
    detectArchitecture,
  ]);

  // Handle register edit
  const handleEditStart = (registerName: string, currentValue: string) => {
    if (!isInBreakState) return;
    setEditingRegister(registerName);
    setEditValue(currentValue);
  };

  const handleEditCancel = () => {
    setEditingRegister(null);
    setEditValue("");
  };

  const handleEditSave = async (registerName: string) => {
    try {
      // Validate hex value
      let numericValue: number;
      if (editValue.startsWith("0x") || editValue.startsWith("0X")) {
        numericValue = parseInt(editValue, 16);
      } else {
        numericValue = parseInt(editValue, 10);
      }

      if (isNaN(numericValue)) {
        throw new Error("Invalid value format");
      }

      if (!currentThreadId) {
        throw new Error("No thread selected - cannot write register");
      }

      const response = await apiClient.writeRegister(
        registerName.toLowerCase(),
        numericValue,
        currentThreadId
      );

      if (response.success) {
        // Update local state immediately for responsiveness
        setRegisters((prev) =>
          prev.map((reg) =>
            reg.name === registerName
              ? {
                  ...reg,
                  value: `0x${numericValue.toString(16).padStart(16, "0").toUpperCase()}`,
                }
              : reg
          )
        );

        setSnackbar({
          open: true,
          message: `Register ${registerName} updated successfully`,
          severity: "success",
        });

        // Reload register values from server to confirm the write
        setTimeout(() => loadRegisterValues(), 100);
      } else {
        throw new Error(response.message || "Failed to write register");
      }
    } catch (error) {
      console.error("Failed to write register:", error);
      setSnackbar({
        open: true,
        message:
          error instanceof Error ? error.message : "Failed to write register",
        severity: "error",
      });
    } finally {
      setEditingRegister(null);
      setEditValue("");
    }
  };

  const handleRefresh = () => {
    loadRegisterValues();
  };

  if (!open) return null;

  return (
    <Box
      sx={{
        gridArea: "registers",
        backgroundColor: "#1e1e1e",
        borderLeft: "1px solid #2d2d30",
        width: `${panelWidth}px`,
        minWidth: "200px",
        maxWidth: "600px",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        zIndex: 10,
        "&::-webkit-scrollbar": {
          width: "8px",
        },
        "&::-webkit-scrollbar-track": {
          background: "#1e1e1e",
        },
        "&::-webkit-scrollbar-thumb": {
          background: "#404040",
          borderRadius: "4px",
        },
        "&::-webkit-scrollbar-thumb:hover": {
          background: "#5a5a5e",
        },
      }}
    >
      {/* Resizer handle on left edge */}
      <VerticalResizer
        onMouseDown={handleResizeMouseDown}
        isResizing={isResizing}
      />

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          borderBottom: "1px solid #2d2d30",
          backgroundColor: "#252526",
          position: "sticky",
          top: 0,
          zIndex: 1,
          minHeight: "40px",
          height: "40px",
          "@media (max-height: 800px)": {
            padding: "4px 8px",
            minHeight: "30px",
            height: "30px",
          },
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Memory
            sx={{ fontSize: "14px", color: "#4fc1ff", marginTop: "-1px" }}
          />
          <Typography
            sx={{
              fontSize: "12px",
              fontWeight: "bold",
              color: "#4fc1ff",
              lineHeight: 1,
              "@media (max-height: 800px)": {
                fontSize: "10px",
              },
            }}
          >
            Registers
          </Typography>
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {isInBreakState && (
            <Tooltip title="Refresh register values">
              <IconButton
                size="small"
                onClick={handleRefresh}
                sx={{
                  color: "#9cdcfe",
                  "&:hover": { backgroundColor: "#2d2d30" },
                }}
              >
                <Refresh fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Copy all registers as JSON">
            <IconButton
              size="small"
              onClick={() => {
                // Build JSON object from current register data
                const jsonData: Record<string, string> = {};
                registers.forEach((reg) => {
                  jsonData[reg.name] = reg.value;
                });
                const jsonStr = JSON.stringify(jsonData, null, 2);
                navigator.clipboard.writeText(jsonStr);
                setSnackbar({
                  open: true,
                  message: "Registers copied to clipboard as JSON",
                  severity: "success",
                });
              }}
              sx={{
                color: "#9cdcfe",
                "&:hover": { backgroundColor: "#2d2d30" },
              }}
            >
              <ContentCopy sx={{ fontSize: "16px" }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box
        sx={{
          p: 1,
          pt: 0.5,
          "@media (max-height: 800px)": {
            p: 0.5,
            pt: 0.25,
          },
        }}
      >
        {/* General Purpose Registers Section */}
        <Typography
          sx={{
            fontSize: "10px",
            fontWeight: "bold",
            color: "#9cdcfe",
            mb: 0.5,
            mt: 0.5,
          }}
        >
          General Purpose Registers
        </Typography>

        {registers
          .filter((reg) => reg.type === "general")
          .map((register) => (
            <RegisterRow
              key={register.name}
              register={register}
              isEditing={editingRegister === register.name}
              editValue={editValue}
              onEditValueChange={setEditValue}
              onEditStart={handleEditStart}
              onEditSave={handleEditSave}
              onEditCancel={handleEditCancel}
              onMemoryNavigate={(address) => {
                console.log(
                  "[RegisterView] Navigate to memory address (General):",
                  register.name,
                  address
                );
                uiActions.setMemoryAddress(address);
              }}
              canEdit={isInBreakState}
              isChanged={changedRegisters.has(register.name.toLowerCase())}
            />
          ))}

        {/* Special Registers Section */}
        <Typography
          sx={{
            fontSize: "10px",
            fontWeight: "bold",
            color: "#dcdcaa",
            mb: 0.5,
            mt: 1,
            pt: 0.5,
            borderTop: "1px solid #2d2d30",
          }}
        >
          Special Registers
        </Typography>

        {registers
          .filter((reg) => reg.type === "special")
          .map((register) => (
            <RegisterRow
              key={register.name}
              register={register}
              isEditing={editingRegister === register.name}
              editValue={editValue}
              onEditValueChange={setEditValue}
              onEditStart={handleEditStart}
              onEditSave={handleEditSave}
              onEditCancel={handleEditCancel}
              onMemoryNavigate={(address) => {
                console.log(
                  "[RegisterView] Navigate to memory address (Special):",
                  register.name,
                  address
                );
                uiActions.setMemoryAddress(address);
              }}
              canEdit={isInBreakState}
              isSpecial
              isChanged={changedRegisters.has(register.name.toLowerCase())}
            />
          ))}
      </Box>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

interface RegisterRowProps {
  register: Register;
  isEditing: boolean;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onEditStart: (name: string, value: string) => void;
  onEditSave: (name: string) => void;
  onEditCancel: () => void;
  onMemoryNavigate: (address: string) => void;
  canEdit: boolean;
  isSpecial?: boolean;
  isChanged?: boolean;
}

const RegisterRow: React.FC<RegisterRowProps> = ({
  register,
  isEditing,
  editValue,
  onEditValueChange,
  onEditStart,
  onEditSave,
  onEditCancel,
  onMemoryNavigate,
  canEdit,
  isSpecial = false,
  isChanged = false,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
  } | null>(null);

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      mouseX: event.clientX,
      mouseY: event.clientY,
    });
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleCopyValue = () => {
    navigator.clipboard.writeText(register.value);
    handleCloseContextMenu();
  };

  const nameColor = isSpecial ? "#dcdcaa" : "#9cdcfe";
  // Changed registers: orange-red (#f48771)
  // Special registers (unchanged): blue (#4fc1ff)
  // General registers (unchanged): orange (#ce9178)
  const valueColor = isChanged ? "#f48771" : isSpecial ? "#4fc1ff" : "#ce9178";

  if (isEditing) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          py: 0.1,
          px: 0.5,
          fontSize: "11px",
          fontFamily: "monospace",
          borderRadius: "2px",
          backgroundColor: "#2d2d30",
          "@media (max-height: 800px)": {
            fontSize: "9px",
            py: 0,
            px: 0.25,
          },
        }}
      >
        <Typography
          sx={{
            color: nameColor,
            fontSize: "inherit",
            fontFamily: "inherit",
            fontWeight: "bold",
            minWidth: "40px",
            mr: 1,
          }}
        >
          {register.name}
        </Typography>
        <TextField
          size="small"
          value={editValue}
          onChange={(e) => onEditValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onEditSave(register.name);
            } else if (e.key === "Escape") {
              onEditCancel();
            }
          }}
          sx={{
            flex: 1,
            "& .MuiInputBase-input": {
              fontSize: "11px",
              fontFamily: "monospace",
              color: valueColor,
              py: 0.25,
              px: 0.5,
            },
            "& .MuiOutlinedInput-root": {
              "& fieldset": {
                borderColor: "#404040",
              },
              "&:hover fieldset": {
                borderColor: "#5a5a5e",
              },
              "&.Mui-focused fieldset": {
                borderColor: "#007acc",
              },
            },
          }}
        />
        <IconButton
          size="small"
          onClick={() => onEditSave(register.name)}
          sx={{ ml: 0.5, color: "#4fc1ff", minWidth: "auto", p: 0.25 }}
        >
          <Check fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          onClick={onEditCancel}
          sx={{ color: "#f48771", minWidth: "auto", p: 0.25 }}
        >
          <Close fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        py: 0.1,
        px: 0.5,
        fontSize: "11px",
        fontFamily: "monospace",
        borderRadius: "2px",
        "&:hover": {
          backgroundColor: canEdit ? "#2d2d30" : "transparent",
          "& .view-icon": {
            opacity: 1,
          },
        },
        cursor: canEdit ? "pointer" : "default",
        "@media (max-height: 800px)": {
          fontSize: "9px",
          py: 0,
          px: 0.25,
        },
      }}
      onClick={(e) => {
        // Don't trigger edit if context menu is open or clicking on the view icon
        if (
          contextMenu !== null ||
          !canEdit ||
          !register.editable ||
          (e.target as HTMLElement).closest(".view-icon-button")
        ) {
          return;
        }
        onEditStart(register.name, register.value);
      }}
      onContextMenu={handleContextMenu}
    >
      <Typography
        sx={{
          color: nameColor,
          fontSize: "inherit",
          fontFamily: "inherit",
          fontWeight: "bold",
          minWidth: "40px",
        }}
      >
        {register.name}
      </Typography>

      <Box
        sx={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 0.5,
        }}
      >
        {/* View Icon */}
        <IconButton
          className="view-icon-button view-icon"
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            console.log(
              "[RegisterView] Navigate to memory address:",
              register.name,
              register.value
            );
            onMemoryNavigate(register.value);
          }}
          sx={{
            opacity: 0,
            transition: "opacity 0.2s",
            color: "#9cdcfe",
            minWidth: "auto",
            p: 0.25,
            "&:hover": {
              backgroundColor: "#3c3c3c",
            },
          }}
        >
          <OpenInNew sx={{ fontSize: "11px" }} />
        </IconButton>

        <Typography
          sx={{
            color: valueColor,
            fontSize: "inherit",
            fontFamily: "inherit",
            letterSpacing: "0.5px",
            cursor: canEdit && register.editable ? "pointer" : "default",
            backgroundColor: isChanged
              ? "rgba(244, 135, 113, 0.2)"
              : "transparent",
            "&:hover": {
              backgroundColor:
                canEdit && register.editable
                  ? "rgba(76, 175, 80, 0.1)"
                  : isChanged
                    ? "rgba(244, 135, 113, 0.25)"
                    : "transparent",
            },
            borderRadius: "2px",
            px: 0.5,
            py: 0.1, // Reduced from 0.25 to 0.1 to match row spacing
            transition: "background-color 0.3s ease",
          }}
          onClick={(e) => {
            e.stopPropagation();
            // Don't trigger edit if context menu is open
            if (contextMenu !== null || !canEdit || !register.editable) {
              return;
            }
            onEditStart(register.name, register.value);
          }}
        >
          {register.value}
        </Typography>
      </Box>

      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={handleCopyValue}>Copy Value</MenuItem>
      </Menu>
    </Box>
  );
};
