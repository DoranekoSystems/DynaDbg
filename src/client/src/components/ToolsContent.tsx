import React from "react";
import { Box, Paper, Tabs, Tab } from "@mui/material";
import { Extension as GhidraIcon } from "@mui/icons-material";
import { GhidraAnalyzer } from "./GhidraAnalyzer";
import { useUIStore } from "../stores/uiStore";
import type { ServerInfo } from "../lib/api";

interface ToolsContentProps {
  serverConnected: boolean;
  serverInfo?: ServerInfo;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;
  return (
    <Box
      role="tabpanel"
      hidden={value !== index}
      id={`tools-tabpanel-${index}`}
      aria-labelledby={`tools-tab-${index}`}
      sx={{
        flex: 1,
        display: value === index ? "flex" : "none",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
      }}
      {...other}
    >
      {value === index && children}
    </Box>
  );
}

export const ToolsContent: React.FC<ToolsContentProps> = ({
  serverConnected,
  serverInfo,
}) => {
  const currentTab = useUIStore((state) => state.toolsState.currentTab);
  const setToolsTab = useUIStore((state) => state.actions.setToolsTab);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setToolsTab(newValue);
  };

  return (
    <Box sx={{ width: "100%", height: "100%", p: 2 }}>
      {/* Chrome-style tabs matching InformationContent */}
      <Box sx={{ display: "flex", alignItems: "flex-end" }}>
        <Tabs
          value={currentTab}
          onChange={handleTabChange}
          aria-label="Tools tabs"
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
              gap: 0.5,
              "&.Mui-selected": {
                backgroundColor: "background.paper",
                color: "primary.main",
                fontWeight: 600,
              },
            },
          }}
        >
          <Tab
            icon={<GhidraIcon sx={{ fontSize: 12 }} />}
            iconPosition="start"
            label="Ghidra"
            id="tools-tab-0"
            aria-controls="tools-tabpanel-0"
          />
        </Tabs>
      </Box>

      {/* Content Panel */}
      <Paper
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "background.paper",
          borderRadius: "0 4px 4px 4px",
          border: "1px solid",
          borderColor: "divider",
          overflow: "hidden",
          minHeight: 0,
          height: "calc(100% - 28px)",
        }}
      >
        {/* Tab Content */}
        <Box
          sx={{
            flex: 1,
            height: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <TabPanel value={currentTab} index={0}>
            <GhidraAnalyzer
              serverConnected={serverConnected}
              targetOs={serverInfo?.target_os}
            />
          </TabPanel>
        </Box>
      </Paper>
    </Box>
  );
};

export default ToolsContent;
