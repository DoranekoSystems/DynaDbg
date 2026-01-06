import { useState } from "react";
import { Box, Typography, Paper, Tabs, Tab } from "@mui/material";
import {
  Link as AttachIcon,
  RocketLaunch as SpawnIcon,
} from "@mui/icons-material";
import { ServerConnection } from "./ServerConnection";
import { ProcessManager } from "./ProcessManager";
import { SpawnManager } from "./SpawnManager";
import { LinuxSpawnManager } from "./LinuxSpawnManager";
import { ModuleInfo } from "../lib/api";
import { useAppState } from "../hooks/useAppState";

interface ServerContentProps {
  // Legacy props for backward compatibility, but we'll use global store instead
  onModulesUpdate?: (modules: ModuleInfo[]) => void;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`process-tabpanel-${index}`}
      aria-labelledby={`process-tab-${index}`}
      {...other}
    >
      {value === index && <Box>{children}</Box>}
    </div>
  );
}

export const ServerContent = ({ onModulesUpdate }: ServerContentProps) => {
  // Use new app state system instead of props
  const { system, systemActions } = useAppState();
  const serverConnected = system.serverConnected;
  const serverInfo = system.serverInfo;

  // Check if target OS is iOS
  const isIOS = serverInfo?.target_os?.toLowerCase() === "ios";

  // Check if target OS is Linux
  const isLinux = serverInfo?.target_os?.toLowerCase() === "linux";

  // Show Spawn tab for iOS and Linux
  const showSpawnTab = isIOS || isLinux;

  // Tab state: 0 = Attach, 1 = Spawn
  const [tabValue, setTabValue] = useState(0);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  // Callback handlers that update system state (legacy support)
  const handleServerConnectionChange = (
    connected: boolean,
    info?: any,
    host?: string,
    port?: number
  ) => {
    console.log("[ServerContent] Legacy connection change callback:", {
      connected,
      info,
      host,
      port,
    });
    // This is now handled by ServerConnection internally via systemActions
    // But we keep this for legacy compatibility if needed
  };

  const handleModulesUpdate = (modules: ModuleInfo[]) => {
    systemActions.updateModules(modules);
    // Also call the legacy callback if provided
    if (onModulesUpdate) {
      onModulesUpdate(modules);
    }
  };

  return (
    <Box
      sx={{
        gridArea: "main",
        gridColumn: "1 / -1",
        overflow: "auto",
        backgroundColor: "background.default",
        p: 2,
      }}
    >
      <Typography
        variant="h6"
        component="h1"
        gutterBottom
        sx={{ fontSize: "16px", fontWeight: 600 }}
      >
        Server Management
      </Typography>

      <Box sx={{ mb: 3 }}>
        <ServerConnection onConnectionChange={handleServerConnectionChange} />
      </Box>

      {serverConnected && (
        <Box sx={{ maxWidth: "50%" }}>
          {/* Section title for process management */}
          <Typography
            variant="subtitle1"
            sx={{
              fontSize: "16px",
              fontWeight: 600,
              mb: 1,
              color: "text.primary",
            }}
          >
            Process Management
          </Typography>

          {/* Chrome-style tabs at top-left of content */}
          <Box sx={{ display: "flex", alignItems: "flex-end" }}>
            <Tabs
              value={tabValue}
              onChange={handleTabChange}
              aria-label="process management tabs"
              sx={{
                minHeight: "28px",
                "& .MuiTabs-indicator": {
                  display: "none",
                },
                "& .MuiTab-root": {
                  minHeight: "28px",
                  minWidth: "80px",
                  fontSize: "11px",
                  textTransform: "none",
                  fontWeight: 500,
                  px: 1.5,
                  py: 0.5,
                  borderTopLeftRadius: "6px",
                  borderTopRightRadius: "6px",
                  border: "1px solid",
                  borderBottom: "none",
                  borderColor: "divider",
                  backgroundColor: "action.hover",
                  color: "text.secondary",
                  marginRight: "2px",
                  "&.Mui-selected": {
                    backgroundColor: "background.paper",
                    color: "primary.main",
                    fontWeight: 600,
                  },
                },
              }}
            >
              <Tab
                icon={<AttachIcon sx={{ fontSize: "12px" }} />}
                iconPosition="start"
                label="Attach"
                id="process-tab-0"
                aria-controls="process-tabpanel-0"
                sx={{ gap: 0.5 }}
              />
              {showSpawnTab && (
                <Tab
                  icon={<SpawnIcon sx={{ fontSize: "12px" }} />}
                  iconPosition="start"
                  label="Spawn"
                  id="process-tab-1"
                  aria-controls="process-tabpanel-1"
                  sx={{ gap: 0.5 }}
                />
              )}
            </Tabs>
          </Box>

          {/* Content area with top border connecting to tabs */}
          <Box
            sx={{
              borderTop: "1px solid",
              borderColor: "divider",
              mt: "-1px",
            }}
          >
            <TabPanel value={tabValue} index={0}>
              <ProcessManager onModulesUpdate={handleModulesUpdate} />
            </TabPanel>
            {isIOS && (
              <TabPanel value={tabValue} index={1}>
                <SpawnManager onModulesUpdate={handleModulesUpdate} />
              </TabPanel>
            )}
            {isLinux && (
              <TabPanel value={tabValue} index={1}>
                <LinuxSpawnManager onModulesUpdate={handleModulesUpdate} />
              </TabPanel>
            )}
          </Box>
        </Box>
      )}

      {!serverConnected && (
        <Paper
          sx={{
            p: 3,
            textAlign: "center",
            mt: 3,
            backgroundColor: "background.paper",
          }}
        >
          <Typography
            variant="body1"
            color="text.secondary"
            sx={{ fontSize: "14px", fontWeight: 600 }}
          >
            Connect to a server to manage processes
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 1, fontSize: "12px" }}
          >
            Enter the server IP address and port above to establish a
            connection.
          </Typography>
        </Paper>
      )}
    </Box>
  );
};
