import React, { useState, useEffect } from "react";
import {
  Box,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  ListItemButton,
  Badge,
  Typography,
  Stack,
  IconButton,
  Tooltip,
  Avatar,
} from "@mui/material";
import {
  MenuBook,
  Help,
  Newspaper,
  Settings,
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

export type HomeSubPage =
  | "home"
  | "help"
  | "documentation"
  | "about"
  | "news"
  | "settings";

interface HomeSidebarProps {
  currentSubPage?: HomeSubPage;
  onSubPageChange?: (subPage: HomeSubPage) => void;
  unreadNewsCount?: number;
}

export const HomeSidebar: React.FC<HomeSidebarProps> = ({
  currentSubPage = "home",
  onSubPageChange,
  unreadNewsCount = 0,
}) => {
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);

  // Fetch sponsors on mount
  useEffect(() => {
    const fetchSponsors = async () => {
      try {
        const response = await fetch(
          "https://sponsors.dynadbg.com/public/sponsors.json",
          {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
          }
        );
        if (response.ok) {
          const data: SponsorResponse = await response.json();
          setSponsors(data.sponsors.slice(0, 5));
        } else {
          // Fetch failed - hide sponsors section
          setSponsors([]);
        }
      } catch (error) {
        console.log("Failed to fetch sponsors:", error);
        // Fetch failed - hide sponsors section (no fallback)
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

  return (
    <Box
      sx={{
        height: "100%",
        backgroundColor: "background.paper",
        borderRight: 1,
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        px: 1,
        pt: 2,
        pb: 0,
      }}
    >
      {/* Main navigation items */}
      <List sx={{ p: 0 }}>
        <ListItem disablePadding>
          <ListItemButton
            selected={currentSubPage === "news"}
            onClick={() => onSubPageChange?.("news")}
            sx={{
              borderRadius: 1,
              mb: 0.5,
              py: 1,
              px: 2,
              "&:hover": { backgroundColor: "action.hover" },
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
            }}
          >
            <ListItemIcon>
              <Badge
                badgeContent={unreadNewsCount}
                color="error"
                sx={{
                  "& .MuiBadge-badge": {
                    fontSize: "0.65rem",
                    minWidth: 16,
                    height: 16,
                  },
                }}
              >
                <Newspaper />
              </Badge>
            </ListItemIcon>
            <ListItemText primary="News" />
          </ListItemButton>
        </ListItem>

        <ListItem disablePadding>
          <ListItemButton
            selected={currentSubPage === "documentation"}
            onClick={() => onSubPageChange?.("documentation")}
            sx={{
              borderRadius: 1,
              mb: 0.5,
              py: 1,
              px: 2,
              "&:hover": { backgroundColor: "action.hover" },
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
            }}
          >
            <ListItemIcon>
              <MenuBook />
            </ListItemIcon>
            <ListItemText primary="Documentation" />
          </ListItemButton>
        </ListItem>

        <ListItem disablePadding>
          <ListItemButton
            selected={currentSubPage === "settings"}
            onClick={() => onSubPageChange?.("settings")}
            sx={{
              borderRadius: 1,
              mb: 0.5,
              py: 1,
              px: 2,
              "&:hover": { backgroundColor: "action.hover" },
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
            }}
          >
            <ListItemIcon>
              <Settings />
            </ListItemIcon>
            <ListItemText primary="Settings" />
          </ListItemButton>
        </ListItem>

        <ListItem disablePadding>
          <ListItemButton
            selected={currentSubPage === "help"}
            onClick={() => onSubPageChange?.("help")}
            sx={{
              borderRadius: 1,
              py: 1,
              px: 2,
              "&:hover": { backgroundColor: "action.hover" },
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
            }}
          >
            <ListItemIcon>
              <Help />
            </ListItemIcon>
            <ListItemText primary="Help" />
          </ListItemButton>
        </ListItem>
      </List>

      {/* Spacer */}
      <Box sx={{ flex: 1, minHeight: 0 }} />

      {/* Sponsors Section - matches HomePage Footer height when on home, compact otherwise */}
      {sponsors.length > 0 && (
        <Box
          sx={{
            flexShrink: 0,
            ...(currentSubPage === "home" && {
              minHeight: "120px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-start",
            }),
            borderTop: "1px solid #374151",
            py: currentSubPage === "home" ? 1.5 : 1,
            px: 1,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              fontSize: "10px",
              fontWeight: 600,
              color: "text.secondary",
              mb: 1,
              px: 1,
            }}
          >
            <SponsorIcon sx={{ fontSize: "14px", color: "error.main" }} />
            Sponsors
          </Typography>
          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              flexWrap: "wrap",
              justifyContent: "flex-start",
              px: 0.5,
              gap: 0.5,
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
                      width: 24,
                      height: 24,
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
    </Box>
  );
};
