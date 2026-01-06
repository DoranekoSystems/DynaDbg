import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  Chip,
  AppBar,
  Toolbar,
  Card,
  CardContent,
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
} from "@mui/material";
import { BugReport, PlayArrow, Pause } from "@mui/icons-material";
import { WatchpointInfo } from "../types";
import { useTauriExceptionStore } from "../hooks/useTauriExceptionStore";
import { encodeAddressToLibraryExpression } from "../utils/addressEncoder";
import { useAppState } from "../hooks/useAppState";

interface WatchpointExceptionWindowProps {
  watchpoint: WatchpointInfo;
  onClose: (watchpointId: string) => void;
}

interface ProcessedWatchpointException {
  index: number;
  count: number;
  address: string;
  bytecode: string;
  opcode: string;
  timestamp: Date;
}

export const WatchpointExceptionWindow: React.FC<
  WatchpointExceptionWindowProps
> = ({ watchpoint, onClose: _onClose }) => {
  const [exceptions, setExceptions] = useState<ProcessedWatchpointException[]>(
    []
  );
  const [error, setError] = useState<string | null>(null);
  // isMonitoring controls UI updates (exception collection continues even when false)
  const [isMonitoring, setIsMonitoring] = useState(true);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    exception: ProcessedWatchpointException | null;
  } | null>(null);

  // Use Tauri store (data collected by global exception handler)
  const {
    getWatchpointExceptions,
    clearWatchpointExceptions,
    exceptions: tauriExceptions,
  } = useTauriExceptionStore();

  // Get attached modules from app state
  const { system } = useAppState();
  const attachedModules = system.attachedModules || [];

  // Encode PC addresses to library+offset expressions
  const addressDetails = useMemo(() => {
    const detailsMap = new Map<string, string>();
    if (!attachedModules || attachedModules.length === 0) {
      return detailsMap;
    }

    exceptions.forEach((exception) => {
      // Parse address to numeric value
      const addressNum = parseInt(exception.address, 16);
      if (!isNaN(addressNum)) {
        // Try to encode to library+offset expression
        const libraryExpr = encodeAddressToLibraryExpression(
          addressNum,
          attachedModules,
          true // prefer short filename
        );
        if (libraryExpr) {
          detailsMap.set(exception.address, libraryExpr);
        }
      }
    });

    return detailsMap;
  }, [exceptions, attachedModules]);

  // Fetch and filter exceptions from Tauri store
  // Skip UI updates when isMonitoring is false
  const fetchExceptions = useCallback(async () => {
    // Skip UI updates when monitoring is OFF
    if (!isMonitoring) {
      return;
    }

    try {
      // Get watchpoint exceptions only
      const watchpointExceptions = await getWatchpointExceptions();

      // Filter exceptions related to this specific watchpoint
      const watchpointAddr =
        typeof watchpoint.address === "string"
          ? parseInt(watchpoint.address, 16)
          : watchpoint.address;

      const filteredExceptions = watchpointExceptions.filter((ex) => {
        const memoryAddr = ex.memory_address;
        if (!memoryAddr) return false;

        // Check if memory address is within watchpoint range
        return (
          memoryAddr >= watchpointAddr &&
          memoryAddr < watchpointAddr + watchpoint.size
        );
      });

      // Group by PC address and count
      const exceptionMap = new Map<string, ProcessedWatchpointException>();

      filteredExceptions.forEach((ex) => {
        const pcAddr = ex.address;
        if (exceptionMap.has(pcAddr)) {
          const existing = exceptionMap.get(pcAddr)!;
          existing.count += 1;
        } else {
          exceptionMap.set(pcAddr, {
            index: exceptionMap.size,
            count: 1,
            address: pcAddr,
            bytecode: ex.bytecode || "unknown",
            opcode: ex.opcode || "unknown",
            timestamp: new Date(ex.timestamp),
          });
        }
      });

      const groupedExceptions = Array.from(exceptionMap.values());
      setExceptions(groupedExceptions);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch watchpoint exceptions:", err);
      setError("Failed to fetch exceptions from Tauri store");
    }
  }, [watchpoint, getWatchpointExceptions, isMonitoring]);

  // Context menu handlers
  const handleContextMenu = useCallback(
    (event: React.MouseEvent, exception: ProcessedWatchpointException) => {
      event.preventDefault();
      setContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        exception,
      });
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleCopyAddress = useCallback(() => {
    if (contextMenu?.exception) {
      navigator.clipboard.writeText(contextMenu.exception.address);
    }
    handleCloseContextMenu();
  }, [contextMenu, handleCloseContextMenu]);

  const handleCopyDetail = useCallback(() => {
    if (contextMenu?.exception) {
      const detail = addressDetails.get(contextMenu.exception.address) || "-";
      navigator.clipboard.writeText(detail);
    }
    handleCloseContextMenu();
  }, [contextMenu, addressDetails, handleCloseContextMenu]);

  const handleCopyBytecode = useCallback(() => {
    if (contextMenu?.exception) {
      navigator.clipboard.writeText(contextMenu.exception.bytecode);
    }
    handleCloseContextMenu();
  }, [contextMenu, handleCloseContextMenu]);

  const handleCopyInstruction = useCallback(() => {
    if (contextMenu?.exception) {
      navigator.clipboard.writeText(contextMenu.exception.opcode);
    }
    handleCloseContextMenu();
  }, [contextMenu, handleCloseContextMenu]);

  // Clear old exceptions for this watchpoint when window opens
  useEffect(() => {
    const watchpointAddr =
      typeof watchpoint.address === "string"
        ? parseInt(watchpoint.address, 16)
        : watchpoint.address;

    // Clear old exceptions for this watchpoint when window opens (fresh start)
    clearWatchpointExceptions(watchpointAddr, watchpoint.size).then(() => {
      console.log(
        `Cleared old exceptions for watchpoint at ${watchpoint.address}`
      );
      // Fetch any new exceptions after clearing
      fetchExceptions();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Monitor Tauri events for exception updates
  useEffect(() => {
    // Poll for updates periodically
    const interval = setInterval(fetchExceptions, 250);

    return () => {
      clearInterval(interval);
    };
  }, [fetchExceptions]);

  // Also update when tauriExceptions changes
  useEffect(() => {
    fetchExceptions();
  }, [tauriExceptions, fetchExceptions]);

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* App Bar */}
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar variant="dense">
          <BugReport color="warning" sx={{ mr: 1 }} />
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Watchpoint - {watchpoint.address}
          </Typography>
          <Chip
            label={isMonitoring ? "Monitoring" : "Paused"}
            color={isMonitoring ? "success" : "default"}
            size="small"
            sx={{ mr: 1 }}
          />
          <Tooltip
            title={isMonitoring ? "Pause UI Updates" : "Resume UI Updates"}
          >
            <IconButton
              size="small"
              onClick={() => setIsMonitoring(!isMonitoring)}
              color={isMonitoring ? "error" : "primary"}
            >
              {isMonitoring ? <Pause /> : <PlayArrow />}
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "hidden", px: 2, pb: 2, py: 2 }}>
        {/* Watchpoint Info Card */}
        <Card sx={{ mb: 2 }}>
          <CardContent sx={{ py: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Monitoring Watchpoint
            </Typography>
            <Box display="flex" gap={2} alignItems="center">
              <Typography variant="body2" fontFamily="monospace">
                Address: <strong>{watchpoint.address}</strong>
              </Typography>
              <Typography variant="body2">
                Size: <strong>{watchpoint.size} bytes</strong>
              </Typography>
              <Typography variant="body2">
                Access: <strong>{watchpoint.accessType.toUpperCase()}</strong>
              </Typography>
            </Box>
          </CardContent>
        </Card>

        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}

        <TableContainer component={Paper} sx={{ height: "calc(100% - 100px)" }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell>Index</TableCell>
                <TableCell>Count</TableCell>
                <TableCell>PC Address</TableCell>
                <TableCell>Detail</TableCell>
                <TableCell>Bytecode</TableCell>
                <TableCell>Opcode</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {exceptions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography variant="body2" color="text.secondary">
                      Monitoring for exceptions...
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                exceptions.map((exception) => (
                  <TableRow
                    key={exception.address}
                    hover
                    onContextMenu={(e) => handleContextMenu(e, exception)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
                        {exception.index}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontFamily="monospace"
                        fontWeight="bold"
                        color={exception.count > 1 ? "warning.main" : "inherit"}
                      >
                        {exception.count}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontFamily="monospace"
                        color="primary"
                      >
                        {exception.address}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontFamily="monospace"
                        sx={{ color: "#90ee90" }}
                      >
                        {addressDetails.get(exception.address) || "-"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontFamily="monospace"
                        fontSize="0.8rem"
                      >
                        {exception.bytecode}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontFamily="monospace"
                        fontWeight="bold"
                      >
                        {exception.opcode}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

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
          <MenuItem onClick={handleCopyAddress}>Copy Address</MenuItem>
          <MenuItem onClick={handleCopyDetail}>Copy Detail</MenuItem>
          <MenuItem onClick={handleCopyBytecode}>Copy Bytecode</MenuItem>
          <MenuItem onClick={handleCopyInstruction}>Copy Instruction</MenuItem>
        </Menu>
      </Box>
    </Box>
  );
};
