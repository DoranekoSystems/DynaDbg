import React, { useEffect, useState, useCallback } from "react";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { useParams } from "react-router-dom";
import { darkTheme } from "../utils/theme";
import { WatchpointExceptionWindow } from "../components/WatchpointExceptionWindow";
import { getApiClient } from "../lib/api";
import { useTauriSystemStateSingleton } from "../hooks/useTauriSystemStateSingleton";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WatchpointInfo } from "../types";

const WatchpointExceptionPageInner: React.FC = () => {
  const { watchpointId } = useParams<{ watchpointId: string }>();
  const [watchpoint, setWatchpoint] = useState<WatchpointInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  // Get connection info from Tauri global state instead of URL parameters
  const { state: tauriState, isLoading: tauriLoading } =
    useTauriSystemStateSingleton();

  console.log(
    "WatchpointExceptionPage rendered with watchpointId:",
    watchpointId
  );

  console.log("Connection parameters from Tauri state:", {
    host: tauriState?.connectionHost,
    port: tauriState?.connectionPort,
    serverConnected: tauriState?.serverConnected,
    debuggerConnected: tauriState?.debuggerConnected,
  });

  // Initialize API client and load watchpoint details
  useEffect(() => {
    // Wait for Tauri state to load
    if (tauriLoading || !tauriState) {
      console.log("Waiting for Tauri state to load...");
      return;
    }

    // Ensure we have connection info from Tauri state
    if (!tauriState.connectionHost || !tauriState.connectionPort) {
      console.error("No connection info available in Tauri state");
      setError("No connection information available");
      setLoading(false);
      return;
    }

    // Skip reload if watchpoint is already loaded
    if (watchpoint) {
      console.log("Watchpoint already loaded, skipping reload");
      return;
    }

    const initializeAndLoad = async () => {
      console.log("Initializing API client with Tauri state connection info:", {
        host: tauriState.connectionHost,
        port: tauriState.connectionPort,
      });

      const apiClient = getApiClient();
      apiClient.updateConnection(
        tauriState.connectionHost!,
        tauriState.connectionPort!
      );

      // Now load the watchpoint
      try {
        await loadWatchpoint();
      } catch (error) {
        console.error("Failed to initialize and load watchpoint:", error);
        setError(`Failed to load watchpoint: ${error}`);
        setLoading(false);
      }
    };

    const loadWatchpoint = async () => {
      console.log("Loading watchpoint with ID:", watchpointId);

      if (!watchpointId) {
        console.error("No watchpoint ID provided");
        setError("No watchpoint ID provided");
        setLoading(false);
        return;
      }

      // Try to find watchpoint in Tauri state first
      if (tauriState?.watchpoints) {
        const foundWatchpoint = tauriState.watchpoints.find(
          (wp: any) => wp.id === watchpointId
        );

        if (foundWatchpoint) {
          console.log("Found watchpoint in Tauri state:", foundWatchpoint);
          const watchpointInfo: WatchpointInfo = {
            id: foundWatchpoint.id,
            address: foundWatchpoint.address,
            size: foundWatchpoint.size,
            accessType: foundWatchpoint.accessType as any,
            hitCount: foundWatchpoint.hitCount,
            createdAt: new Date(foundWatchpoint.createdAt),
            description: foundWatchpoint.description,
          };
          setWatchpoint(watchpointInfo);
          setLoading(false);
          return;
        }
      }

      // Fallback to API call if not found in state
      try {
        console.log("Fetching watchpoints from API...");
        const apiClient = getApiClient();
        const response = await apiClient.listWatchpoints();
        console.log("API response:", response);

        if (response.success) {
          const foundWatchpoint = response.watchpoints.find(
            (wp) => wp.id === watchpointId
          );
          console.log("Found watchpoint:", foundWatchpoint);

          if (foundWatchpoint) {
            // Convert to our WatchpointInfo format
            const watchpointInfo: WatchpointInfo = {
              id: foundWatchpoint.id,
              address: `0x${foundWatchpoint.address.toString(16).toUpperCase()}`,
              size: foundWatchpoint.size,
              accessType: foundWatchpoint.access_type as any,
              hitCount: foundWatchpoint.hit_count || 0,
              createdAt: foundWatchpoint.created_at
                ? new Date(foundWatchpoint.created_at)
                : new Date(),
              description: foundWatchpoint.description,
            };
            console.log("Setting watchpoint info:", watchpointInfo);
            setWatchpoint(watchpointInfo);
          } else {
            console.error(`Watchpoint with ID ${watchpointId} not found`);
            setError(`Watchpoint with ID ${watchpointId} not found`);
          }
        } else {
          console.error("API response failed:", response.message);
          setError("Failed to load watchpoint from server");
        }
      } catch (err) {
        console.error("Exception while loading watchpoint:", err);
        setError("Failed to connect to server");
      } finally {
        console.log("Loading complete");
        setLoading(false);
      }
    };

    initializeAndLoad();
  }, [watchpointId, tauriState, tauriLoading]);

  const handleClose = useCallback(
    async (_id: string) => {
      console.log("handleClose called for watchpoint:", watchpoint);

      // Set closing flag to prevent error display during cleanup
      setIsClosing(true);

      // Remove watchpoint first to ensure it's deleted even if window close fails
      if (watchpoint) {
        try {
          console.log("Removing watchpoint from server...");
          const apiClient = getApiClient();
          const addressNum = parseInt(watchpoint.address, 16);
          await apiClient.removeWatchpoint({ address: addressNum });
          console.log("Watchpoint removed successfully");
        } catch (error) {
          console.error("Failed to remove watchpoint:", error);
          // Continue with window close even if watchpoint removal fails
        }
      }

      // Close window after watchpoint removal using Tauri API
      try {
        console.log("Closing window...");
        const currentWindow = getCurrentWebviewWindow();
        await currentWindow.close();
      } catch (error) {
        console.error("Failed to close window:", error);
      }
    },
    [watchpoint]
  );

  if (loading) {
    console.log("Rendering loading state");
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: "16px",
            color: "white",
            fontSize: "18px",
          }}
        >
          <div>Loading watchpoint exception monitor...</div>
          <div style={{ fontSize: "14px", opacity: 0.7 }}>
            Watchpoint ID: {watchpointId}
          </div>
        </div>
      </ThemeProvider>
    );
  }

  // Don't show error if window is closing
  if ((error || !watchpoint) && !isClosing) {
    console.log("Rendering error state:", error);
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: "16px",
            color: "#f44336",
            fontSize: "18px",
            padding: "20px",
          }}
        >
          <div>Error: {error || "Unknown error"}</div>
          <div style={{ fontSize: "14px", opacity: 0.7 }}>
            Watchpoint ID: {watchpointId}
          </div>
        </div>
      </ThemeProvider>
    );
  }

  // If closing, show nothing or a closing message
  if (isClosing) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontSize: "16px",
          }}
        >
          Closing...
        </div>
      </ThemeProvider>
    );
  }

  console.log(
    "Rendering WatchpointExceptionWindow with watchpoint:",
    watchpoint
  );

  // Ensure watchpoint is not null before rendering
  if (!watchpoint) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontSize: "16px",
          }}
        >
          Loading...
        </div>
      </ThemeProvider>
    );
  }

  // Use Tauri state for connection info
  if (!tauriState?.connectionHost || !tauriState?.connectionPort) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: "16px",
            color: "#f44336",
            fontSize: "18px",
            padding: "20px",
          }}
        >
          <div>Error: No connection information available in Tauri state</div>
          <div style={{ fontSize: "14px", opacity: 0.7 }}>
            Watchpoint ID: {watchpointId}
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <WatchpointExceptionWindow
        watchpoint={watchpoint}
        onClose={handleClose}
      />
    </ThemeProvider>
  );
};

export const WatchpointExceptionPage: React.FC = () => {
  return <WatchpointExceptionPageInner />;
};
