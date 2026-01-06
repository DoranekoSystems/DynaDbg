import { useState, useEffect } from "react";
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  Typography,
  Paper,
  IconButton,
  Tooltip,
  Avatar,
  Stack,
} from "@mui/material";
import {
  Computer as ProcessIcon,
  Memory as MemoryIcon,
  Search as ScanIcon,
  BugReport as DebugIcon,
  Storage as ModulesIcon,
  Code as AssemblyIcon,
  Settings as SettingsIcon,
  ChevronLeft as CollapseIcon,
  ChevronRight as ExpandIcon,
  Favorite as SponsorIcon,
} from "@mui/icons-material";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Sponsor {
  id: string;
  name: string;
  icon_url: string;
  url: string;
}

interface SponsorResponse {
  sponsors: Sponsor[];
}

interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onNavigate?: (section: string) => void;
  currentSection?: string;
  currentMode?: "debugger" | "server" | "scanner";
  activeFunction?: string;
  onFunctionClick?: (functionName: string, functionAddress?: string) => void;
}

export function Sidebar({
  collapsed,
  onCollapsedChange,
  onNavigate,
  currentSection = "processes",
}: SidebarProps) {
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);

  // Fetch sponsors on mount
  useEffect(() => {
    const fetchSponsors = async () => {
      try {
        const response = await fetch(
          "https://sponsor.dynadbg.com/api/sponsors",
          {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
          }
        );
        if (response.ok) {
          const data: SponsorResponse = await response.json();
          // Limit to 5 sponsors
          setSponsors(data.sponsors.slice(0, 5));
        }
      } catch (error) {
        console.log("Failed to fetch sponsors:", error);
        // Fallback to demo sponsors for testing
        setSponsors([]);
      }
    };
    fetchSponsors();
  }, []);

  const handleSponsorClick = async (url: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open sponsor URL:", error);
    }
  };

  const menuItems = [
    { id: "processes", label: "Processes", icon: <ProcessIcon /> },
    { id: "modules", label: "Modules", icon: <ModulesIcon /> },
    { id: "memory", label: "Memory", icon: <MemoryIcon /> },
    { id: "scanner", label: "Scanner", icon: <ScanIcon /> },
    { id: "debugger", label: "Debugger", icon: <DebugIcon /> },
    { id: "assembly", label: "Assembly", icon: <AssemblyIcon /> },
  ];

  const handleItemClick = (itemId: string) => {
    if (onNavigate) {
      onNavigate(itemId);
    }
  };

  return (
    <Paper
      sx={{
        width: collapsed ? 60 : 240,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderRadius: 0,
        borderRight: "1px solid",
        borderColor: "divider",
        transition: "width 0.3s ease",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          flexShrink: 0,
          p: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          borderBottom: "1px solid",
          borderColor: "divider",
          minHeight: 48,
        }}
      >
        {!collapsed && (
          <Typography
            variant="subtitle2"
            sx={{
              fontSize: "12px",
              fontWeight: 600,
              color: "primary.main",
            }}
          >
            Debug Tools
          </Typography>
        )}
        <Tooltip title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <IconButton
            size="small"
            onClick={() => onCollapsedChange(!collapsed)}
            sx={{
              color: "text.secondary",
              "&:hover": { backgroundColor: "action.hover" },
            }}
          >
            {collapsed ? (
              <ExpandIcon sx={{ fontSize: "16px" }} />
            ) : (
              <CollapseIcon sx={{ fontSize: "16px" }} />
            )}
          </IconButton>
        </Tooltip>
      </Box>

      {/* Navigation */}
      <Box sx={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <List sx={{ p: 0 }}>
          {menuItems.map((item) => (
            <ListItem key={item.id} disablePadding>
              <Tooltip
                title={collapsed ? item.label : ""}
                placement="right"
                disableHoverListener={!collapsed}
              >
                <ListItemButton
                  selected={currentSection === item.id}
                  onClick={() => handleItemClick(item.id)}
                  sx={{
                    minHeight: 36,
                    px: collapsed ? 1 : 2,
                    py: 0.5,
                    "&.Mui-selected": {
                      backgroundColor: "primary.main",
                      color: "primary.contrastText",
                      "&:hover": {
                        backgroundColor: "primary.dark",
                      },
                      "& .MuiListItemIcon-root": {
                        color: "primary.contrastText",
                      },
                    },
                    "&:hover": {
                      backgroundColor: "action.hover",
                    },
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: collapsed ? "auto" : 40,
                      justifyContent: "center",
                      "& .MuiSvgIcon-root": {
                        fontSize: "18px",
                      },
                    }}
                  >
                    {item.icon}
                  </ListItemIcon>
                  {!collapsed && (
                    <ListItemText
                      primary={item.label}
                      primaryTypographyProps={{
                        fontSize: "11px",
                        fontWeight: 500,
                      }}
                    />
                  )}
                </ListItemButton>
              </Tooltip>
            </ListItem>
          ))}
        </List>

        <Divider sx={{ my: 1 }} />

        {/* Settings */}
        <List sx={{ p: 0 }}>
          <ListItem disablePadding>
            <Tooltip
              title={collapsed ? "Settings" : ""}
              placement="right"
              disableHoverListener={!collapsed}
            >
              <ListItemButton
                onClick={() => handleItemClick("settings")}
                sx={{
                  minHeight: 36,
                  px: collapsed ? 1 : 2,
                  py: 0.5,
                  "&:hover": {
                    backgroundColor: "action.hover",
                  },
                }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: collapsed ? "auto" : 40,
                    justifyContent: "center",
                    "& .MuiSvgIcon-root": {
                      fontSize: "18px",
                    },
                  }}
                >
                  <SettingsIcon />
                </ListItemIcon>
                {!collapsed && (
                  <ListItemText
                    primary="Settings"
                    primaryTypographyProps={{
                      fontSize: "11px",
                      fontWeight: 500,
                    }}
                  />
                )}
              </ListItemButton>
            </Tooltip>
          </ListItem>
        </List>
      </Box>

      {/* Sponsors Section */}
      {sponsors.length > 0 && (
        <Box
          sx={{
            flexShrink: 0,
            borderTop: "1px solid #374151",
            py: collapsed ? 0.5 : 1,
            px: collapsed ? 0.5 : 1,
          }}
        >
          {!collapsed && (
            <Typography
              variant="caption"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                fontSize: "9px",
                fontWeight: 600,
                color: "text.secondary",
                mb: 0.5,
                px: 1,
              }}
            >
              <SponsorIcon sx={{ fontSize: "12px", color: "error.main" }} />
              Sponsors
            </Typography>
          )}
          <Stack
            direction={collapsed ? "column" : "row"}
            spacing={0.5}
            sx={{
              flexWrap: "wrap",
              justifyContent: collapsed ? "center" : "flex-start",
              px: collapsed ? 0 : 0.5,
              gap: collapsed ? 0.5 : 0.5,
            }}
          >
            {sponsors.map((sponsor) => (
              <Tooltip key={sponsor.id} title={sponsor.name} placement="top">
                <IconButton
                  size="small"
                  onClick={() => handleSponsorClick(sponsor.url)}
                  sx={{
                    p: 0.25,
                    "&:hover": {
                      backgroundColor: "action.hover",
                      transform: "scale(1.1)",
                    },
                    transition: "transform 0.2s ease",
                  }}
                >
                  <Avatar
                    src={sponsor.icon_url}
                    alt={sponsor.name}
                    sx={{
                      width: collapsed ? 24 : 20,
                      height: collapsed ? 24 : 20,
                      border: "1px solid",
                      borderColor: "divider",
                    }}
                  />
                </IconButton>
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
}
