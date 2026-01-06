import React from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  CardActionArea,
  Stack,
  Chip,
  alpha,
  useMediaQuery,
} from "@mui/material";
import {
  MenuBook as MenuBookIcon,
  Apple as AppleIcon,
  BugReport as BugReportIcon,
  Launch as LaunchIcon,
  Description as DescriptionIcon,
} from "@mui/icons-material";
import { openUrl } from "@tauri-apps/plugin-opener";

interface DocumentItem {
  title: string;
  description: string;
  url: string;
  icon: React.ReactNode;
  tags: string[];
  type: "pdf" | "article" | "video";
}

const documents: DocumentItem[] = [
  {
    title: "Creating a GUI-based macOS & iOS ARM64 Debugger",
    description:
      "Technical documentation explaining the architecture and implementation details of DynaDbg's macOS and iOS ARM64 debugging capabilities. This document covers the low-level debugging mechanisms, Mach API interactions, and GUI integration.",
    url: "https://github.com/DoranekoSystems/DynaDbg/blob/main/doc/Creating%20a%20GUI-based%20macOS%26iOS%20ARM64%20Debugger.pdf",
    icon: <AppleIcon sx={{ fontSize: 48 }} />,
    tags: ["macOS", "iOS", "ARM64", "Technical"],
    type: "pdf",
  },
];

export const DocumentationContent: React.FC = () => {
  // Compact mode for height < 800px
  const isCompactHeight = useMediaQuery("(max-height: 800px)");

  const handleDocumentClick = async (url: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open URL:", error);
      // Fallback to window.open
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Box
      sx={{
        height: "100%",
        overflow: "auto",
        backgroundColor: "#0f0f0f",
        p: isCompactHeight ? 2 : 4,
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
      <Box sx={{ mb: isCompactHeight ? 2 : 4, textAlign: "center" }}>
        <Stack
          direction="row"
          justifyContent="center"
          alignItems="center"
          spacing={2}
          sx={{ mb: isCompactHeight ? 1 : 2 }}
        >
          <MenuBookIcon
            sx={{ fontSize: isCompactHeight ? 28 : 40, color: "#3b82f6" }}
          />
          <Typography
            variant={isCompactHeight ? "h5" : "h4"}
            sx={{
              fontWeight: 600,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Documentation
          </Typography>
        </Stack>
        <Typography variant="body1" color="text.secondary">
          Technical documents and resources for DynaDbg
        </Typography>
      </Box>

      {/* Documents Grid */}
      <Box sx={{ maxWidth: 1000, mx: "auto" }}>
        <Typography
          variant="h6"
          sx={{
            mb: isCompactHeight ? 2 : 3,
            color: "#e5e7eb",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <BugReportIcon sx={{ color: "#3b82f6" }} />
          Technical Documents
        </Typography>

        <Stack spacing={isCompactHeight ? 2 : 3}>
          {documents.map((doc, index) => (
            <Card
              key={index}
              sx={{
                backgroundColor: alpha("#1a1a1a", 0.8),
                border: "1px solid #2d2d2d",
                borderRadius: 2,
                transition: "all 0.3s ease",
                "&:hover": {
                  borderColor: "#3b82f6",
                  transform: "translateY(-2px)",
                  boxShadow: `0 8px 30px ${alpha("#3b82f6", 0.15)}`,
                },
              }}
            >
              <CardActionArea onClick={() => handleDocumentClick(doc.url)}>
                <CardContent sx={{ p: isCompactHeight ? 2 : 3 }}>
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={isCompactHeight ? 2 : 3}
                  >
                    {/* Icon Section */}
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: { xs: "100%", sm: isCompactHeight ? 80 : 120 },
                        height: {
                          xs: isCompactHeight ? 60 : 80,
                          sm: isCompactHeight ? 80 : 120,
                        },
                        backgroundColor: alpha("#3b82f6", 0.1),
                        borderRadius: 2,
                        flexShrink: 0,
                      }}
                    >
                      <Box
                        sx={{
                          color: "#3b82f6",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 1,
                        }}
                      >
                        {doc.icon}
                        <Chip
                          label={doc.type.toUpperCase()}
                          size="small"
                          sx={{
                            height: 20,
                            fontSize: "10px",
                            fontWeight: 600,
                            backgroundColor:
                              doc.type === "pdf"
                                ? alpha("#ef4444", 0.2)
                                : alpha("#3b82f6", 0.2),
                            color: doc.type === "pdf" ? "#f87171" : "#60a5fa",
                            border: "none",
                          }}
                        />
                      </Box>
                    </Box>

                    {/* Content Section */}
                    <Box sx={{ flex: 1 }}>
                      <Stack
                        direction="row"
                        alignItems="center"
                        spacing={1}
                        sx={{ mb: 1 }}
                      >
                        <Typography
                          variant="h6"
                          sx={{
                            color: "#fff",
                            fontWeight: 500,
                            fontSize: "1.1rem",
                          }}
                        >
                          {doc.title}
                        </Typography>
                        <LaunchIcon sx={{ fontSize: 16, color: "#6b7280" }} />
                      </Stack>

                      <Typography
                        variant="body2"
                        sx={{
                          color: "#9ca3af",
                          mb: 2,
                          lineHeight: 1.7,
                        }}
                      >
                        {doc.description}
                      </Typography>

                      <Stack
                        direction="row"
                        spacing={1}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        {doc.tags.map((tag, tagIndex) => (
                          <Chip
                            key={tagIndex}
                            label={tag}
                            size="small"
                            sx={{
                              height: 24,
                              fontSize: "11px",
                              backgroundColor: alpha("#3b82f6", 0.1),
                              color: "#60a5fa",
                              border: "none",
                            }}
                          />
                        ))}
                      </Stack>
                    </Box>
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>

        {/* Coming Soon Section */}
        <Box
          sx={{
            mt: isCompactHeight ? 3 : 6,
            p: isCompactHeight ? 2 : 4,
            backgroundColor: alpha("#1a1a1a", 0.5),
            borderRadius: 2,
            border: "1px dashed #3d3d3d",
            textAlign: "center",
          }}
        >
          <DescriptionIcon
            sx={{
              fontSize: isCompactHeight ? 32 : 48,
              color: "#4b5563",
              mb: isCompactHeight ? 1 : 2,
            }}
          />
          <Typography variant="h6" sx={{ mb: 1, color: "#6b7280" }}>
            More Documentation Coming Soon
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Additional technical documents, tutorials, and API references will
            be added in future updates.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};
