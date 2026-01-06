import React, { useState, useCallback } from "react";
import {
  Box,
  Typography,
  Button,
  Paper,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Alert,
  Snackbar,
  Stack,
} from "@mui/material";
import {
  Delete as DeleteIcon,
  Storage as StorageIcon,
  Cached as CachedIcon,
  Settings,
} from "@mui/icons-material";
import { invoke } from "@tauri-apps/api/core";

// LocalStorage keys used by the app
const LOCALSTORAGE_KEYS = [
  "dynadbg_ghidra_path",
  "dynadbg_analyzed_libraries",
  "dynadbg_news_read_items",
  "dynadbg_license_agreed",
];

export const SettingsContent: React.FC = () => {
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [deleteType, setDeleteType] = useState<
    "all" | "ghidra" | "localStorage"
  >("all");
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const [snackbarSeverity, setSnackbarSeverity] = useState<"success" | "error">(
    "success"
  );

  const showSnackbar = useCallback(
    (message: string, severity: "success" | "error") => {
      setSnackbarMessage(message);
      setSnackbarSeverity(severity);
      setSnackbarOpen(true);
    },
    []
  );

  const handleOpenConfirmDialog = useCallback(
    (type: "all" | "ghidra" | "localStorage") => {
      setDeleteType(type);
      setConfirmDialogOpen(true);
    },
    []
  );

  const handleCloseConfirmDialog = useCallback(() => {
    setConfirmDialogOpen(false);
  }, []);

  const clearLocalStorage = useCallback(() => {
    try {
      LOCALSTORAGE_KEYS.forEach((key) => {
        localStorage.removeItem(key);
      });
      return true;
    } catch (e) {
      console.error("Failed to clear localStorage:", e);
      return false;
    }
  }, []);

  const clearGhidraCache = useCallback(async () => {
    try {
      // Clear Ghidra SQLite database cache
      await invoke("clear_ghidra_cache");
      return true;
    } catch (e) {
      console.error("Failed to clear Ghidra cache:", e);
      return false;
    }
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setConfirmDialogOpen(false);

    let success = true;
    let message = "";

    try {
      switch (deleteType) {
        case "localStorage":
          success = clearLocalStorage();
          message = success
            ? "LocalStorage cache cleared successfully"
            : "Failed to clear localStorage cache";
          break;
        case "ghidra":
          success = await clearGhidraCache();
          message = success
            ? "Ghidra analysis cache cleared successfully"
            : "Failed to clear Ghidra cache";
          break;
        case "all":
          const localStorageSuccess = clearLocalStorage();
          const ghidraSuccess = await clearGhidraCache();
          success = localStorageSuccess && ghidraSuccess;
          message = success
            ? "All caches cleared successfully"
            : "Some caches could not be cleared";
          break;
      }
    } catch (e) {
      success = false;
      message = `Error: ${e}`;
    }

    showSnackbar(message, success ? "success" : "error");
  }, [deleteType, clearLocalStorage, clearGhidraCache, showSnackbar]);

  const getDialogContent = useCallback(() => {
    switch (deleteType) {
      case "localStorage":
        return "This will clear all localStorage data including Ghidra paths and UI preferences. This action cannot be undone.";
      case "ghidra":
        return "This will clear all Ghidra analysis cache from the SQLite database, including decompiled code and function lists. This action cannot be undone.";
      case "all":
        return "This will clear ALL cached data including localStorage and Ghidra analysis cache. You will need to re-analyze libraries with Ghidra. This action cannot be undone.";
    }
  }, [deleteType]);

  return (
    <Box
      sx={{
        height: "100%",
        overflow: "auto",
        backgroundColor: "#0f0f0f",
        p: 4,
        "&::-webkit-scrollbar": {
          width: "8px",
        },
        "&::-webkit-scrollbar-track": {
          background: "#1a1a1a",
        },
        "&::-webkit-scrollbar-thumb": {
          background: "#3a3a3a",
          borderRadius: "4px",
          "&:hover": {
            background: "#4a4a4a",
          },
        },
      }}
    >
      {/* Header Section */}
      <Box
        sx={{
          mb: 4,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <Stack
          direction="row"
          justifyContent="center"
          alignItems="center"
          spacing={1.5}
          sx={{ mb: 1 }}
        >
          <Settings sx={{ fontSize: 32, color: "#3b82f6" }} />
          <Typography
            variant="h4"
            sx={{
              fontWeight: 700,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Settings
          </Typography>
        </Stack>
      </Box>

      <Paper sx={{ mb: 3 }}>
        <Box sx={{ p: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
            <StorageIcon color="primary" />
            <Typography variant="h6">Cache Management</Typography>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Clear cached data stored by the application. This includes Ghidra
            analysis results, decompiled code, and other temporary data.
          </Typography>
        </Box>
        <Divider />
        <List>
          <ListItem>
            <ListItemText
              primary="Clear LocalStorage Cache"
              secondary="Remove UI preferences, Ghidra paths, and other browser-stored data"
            />
            <ListItemSecondaryAction>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<CachedIcon />}
                onClick={() => handleOpenConfirmDialog("localStorage")}
              >
                Clear
              </Button>
            </ListItemSecondaryAction>
          </ListItem>
          <Divider component="li" />
          <ListItem>
            <ListItemText
              primary="Clear Ghidra Analysis Cache"
              secondary="Remove all cached Ghidra analysis results, decompiled code, and function lists from SQLite database"
            />
            <ListItemSecondaryAction>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<CachedIcon />}
                onClick={() => handleOpenConfirmDialog("ghidra")}
              >
                Clear
              </Button>
            </ListItemSecondaryAction>
          </ListItem>
          <Divider component="li" />
          <ListItem>
            <ListItemText
              primary="Clear All Caches"
              secondary="Remove all cached data (LocalStorage + Ghidra SQLite database)"
            />
            <ListItemSecondaryAction>
              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={() => handleOpenConfirmDialog("all")}
              >
                Clear All
              </Button>
            </ListItemSecondaryAction>
          </ListItem>
        </List>
      </Paper>

      {/* Confirmation Dialog */}
      <Dialog
        open={confirmDialogOpen}
        onClose={handleCloseConfirmDialog}
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
      >
        <DialogTitle id="confirm-dialog-title">
          Confirm Cache Deletion
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="confirm-dialog-description">
            {getDialogContent()}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseConfirmDialog} color="inherit">
            Cancel
          </Button>
          <Button
            onClick={handleConfirmDelete}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar for feedback */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={4000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={() => setSnackbarOpen(false)}
          severity={snackbarSeverity}
          sx={{ width: "100%" }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default SettingsContent;
