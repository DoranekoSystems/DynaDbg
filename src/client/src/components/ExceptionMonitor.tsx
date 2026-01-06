import React, { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  Box,
  Chip,
  IconButton,
  Tooltip,
  Alert,
} from "@mui/material";
import {
  PlayArrow,
  Pause,
  Clear,
  Refresh,
  BugReport,
} from "@mui/icons-material";
import { ExceptionInfo } from "../types";
import { getApiClient } from "../lib/api";

interface ExceptionMonitorProps {
  watchpoint: WatchpointInfo; // Single watchpoint instead of array
  onClose: () => void; // Simplified close handler
  open: boolean; // Add open prop to control dialog visibility
}

import { WatchpointInfo } from "../types";

export const ExceptionMonitor: React.FC<ExceptionMonitorProps> = ({
  watchpoint,
  onClose,
  open,
}) => {
  const [exceptions, setExceptions] = useState<ExceptionInfo[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [pollingInterval, setPollingInterval] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Parse instruction field to extract address, bytecode, and opcode
  const parseInstruction = useCallback((instruction: string) => {
    try {
      const parts = instruction.split("|");
      if (parts.length >= 3) {
        const address = parts[0]; // e.g., "0x107ab7920"
        const bytecode = parts[1]; // e.g., "13 00 40 B9"
        const opcodeInfo = parts[2].split("\n")[0]; // e.g., "ldr w19, [x0]"

        return {
          address,
          bytecode,
          opcode: opcodeInfo,
        };
      }
    } catch (error) {
      console.error("Failed to parse instruction:", error);
    }

    return {
      address: "unknown",
      bytecode: "unknown",
      opcode: "unknown",
    };
  }, []);

  // Fetch exception information
  const fetchExceptions = useCallback(async () => {
    try {
      const apiClient = getApiClient();
      const response = await apiClient.getExceptionInfo();

      if (response.success) {
        // response.exceptions is already the flat array we need
        const parsedExceptions = response.exceptions.map(
          (exception: ExceptionInfo, index: number) => {
            // If the exception already has parsed data, use it
            if (exception.address && exception.bytecode && exception.opcode) {
              return exception;
            }

            // Otherwise, try to parse from raw data if available
            const rawData = exception as any;
            if (rawData.instruction) {
              const instructionInfo = parseInstruction(rawData.instruction);
              return {
                ...exception,
                address: instructionInfo.address,
                bytecode: instructionInfo.bytecode,
                opcode: instructionInfo.opcode,
                index: exception.index || index,
                count: exception.count || 1,
                timestamp: exception.timestamp || new Date(),
              };
            }

            return exception;
          }
        );

        // Filter exceptions to only show those related to current watchpoint
        const filteredExceptions = parsedExceptions.filter(
          (exception: ExceptionInfo) => {
            if (!exception.address) return false;

            const exceptionAddr = parseInt(exception.address, 16);
            const watchpointAddr =
              typeof watchpoint.address === "string"
                ? parseInt(watchpoint.address, 16)
                : watchpoint.address;
            return exceptionAddr === watchpointAddr;
          }
        );

        setExceptions(filteredExceptions);
        setError(null);
      } else {
        setError(response.message || "Failed to fetch exception information");
      }
    } catch (error) {
      console.error("Error fetching exceptions:", error);
      setError("Failed to connect to server");
    }
  }, [parseInstruction, watchpoint]);

  // Start polling
  const startPolling = useCallback(() => {
    if (pollingInterval) return;

    setIsPolling(true);
    const interval = setInterval(fetchExceptions, 100); // Poll every 100ms for faster updates
    setPollingInterval(interval);
  }, [fetchExceptions, pollingInterval]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
    setIsPolling(false);
  }, [pollingInterval]);

  // Clear exceptions
  const clearExceptions = useCallback(() => {
    setExceptions([]);
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  // Auto-start polling when dialog opens
  useEffect(() => {
    if (open && !isPolling) {
      startPolling();
    }
  }, [open, isPolling, startPolling]);

  // Stop polling when dialog closes
  useEffect(() => {
    if (!open && isPolling) {
      stopPolling();
    }
  }, [open, isPolling, stopPolling]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          height: "80vh",
          maxHeight: "800px",
        },
      }}
    >
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Box display="flex" alignItems="center" gap={1}>
            <BugReport color="warning" />
            <Typography variant="h6">Watchpoint Exception Monitor</Typography>
            <Chip
              label={isPolling ? "Monitoring" : "Stopped"}
              color={isPolling ? "success" : "default"}
              size="small"
            />
            <Chip
              label="Single watchpoint"
              color="primary"
              size="small"
              variant="outlined"
            />
          </Box>
          <Box display="flex" gap={1}>
            <Tooltip title={isPolling ? "Stop Monitoring" : "Start Monitoring"}>
              <IconButton
                onClick={isPolling ? stopPolling : startPolling}
                color={isPolling ? "error" : "primary"}
              >
                {isPolling ? <Pause /> : <PlayArrow />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh Now">
              <IconButton onClick={fetchExceptions} disabled={isPolling}>
                <Refresh />
              </IconButton>
            </Tooltip>
            <Tooltip title="Clear All">
              <IconButton onClick={clearExceptions} color="warning">
                <Clear />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <TableContainer component={Paper} sx={{ height: "100%" }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell>Index</TableCell>
                <TableCell>Count</TableCell>
                <TableCell>Address</TableCell>
                <TableCell>Bytecode</TableCell>
                <TableCell>Opcode</TableCell>
                <TableCell>Timestamp</TableCell>
                <TableCell>Watchpoint ID</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {exceptions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography variant="body2" color="text.secondary">
                      {isPolling
                        ? "Monitoring for exceptions..."
                        : "No exceptions found"}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                exceptions.map((exception) => (
                  <TableRow key={`${exception.index}-${exception.address}`}>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
                        {exception.index}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
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
                        {exception.opcode || "Loading..."}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {new Date(exception.timestamp).toLocaleTimeString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {exception.watchpointId ? (
                        <Typography
                          variant="body2"
                          color="primary"
                          fontFamily="monospace"
                        >
                          {exception.watchpointId}
                        </Typography>
                      ) : (
                        // Check if this exception matches our current watchpoint
                        (() => {
                          const exceptionAddr = parseInt(exception.address, 16);
                          const watchpointAddr =
                            typeof watchpoint.address === "string"
                              ? parseInt(watchpoint.address, 16)
                              : watchpoint.address;

                          const isMatch = exceptionAddr === watchpointAddr;

                          return isMatch ? (
                            <Box>
                              <Typography
                                variant="body2"
                                color="success.main"
                                fontFamily="monospace"
                                fontSize="0.8rem"
                              >
                                {watchpoint.id}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {watchpoint.accessType} ({watchpoint.size}B)
                              </Typography>
                            </Box>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              -
                            </Typography>
                          );
                        })()
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>

      <DialogActions>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mr: "auto" }}
        >
          {exceptions.length} exception{exceptions.length !== 1 ? "s" : ""}{" "}
          found
        </Typography>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
