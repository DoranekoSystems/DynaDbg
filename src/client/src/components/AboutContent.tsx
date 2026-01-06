import React from "react";
import {
  Box,
  Typography,
  Stack,
  Card,
  CardContent,
  IconButton,
  alpha,
  Avatar,
  useMediaQuery,
  Divider,
} from "@mui/material";
import {
  Favorite as FavoriteIcon,
  Work as WorkIcon,
  Security as SecurityIcon,
  Code as CodeIcon,
  BugReport as BugReportIcon,
  Pets as PetsIcon,
  MusicNote as MusicNoteIcon,
  SetMeal as SetMealIcon,
} from "@mui/icons-material";

// プロフィール画像をインポート
import profileImage from "../assets/profile.png";

interface ExperienceItem {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
}

const experiences: ExperienceItem[] = [
  {
    icon: <SecurityIcon sx={{ fontSize: 32 }} />,
    title: "Security Engineer",
    description: "Web / Mobile / Game / LLM",
    color: "#ef4444",
  },
  {
    icon: <BugReportIcon sx={{ fontSize: 32 }} />,
    title: "Reverse Engineering",
    description: "Low-level analysis & debugging",
    color: "#8b5cf6",
  },
  {
    icon: <CodeIcon sx={{ fontSize: 32 }} />,
    title: "Software Development",
    description: "Full-stack development",
    color: "#3b82f6",
  },
];

const favorites = [
  { icon: <PetsIcon />, label: "Animals", color: "#f97316" },
  { icon: <MusicNoteIcon />, label: "Music", color: "#ec4899" },
  { icon: <SetMealIcon />, label: "Seafood", color: "#06b6d4" },
];

export const AboutContent: React.FC = () => {
  // Compact mode for height < 800px
  const isCompactHeight = useMediaQuery("(max-height: 800px)");

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
      <Box sx={{ maxWidth: 800, mx: "auto" }}>
        {/* Header Section */}
        <Box sx={{ mb: isCompactHeight ? 2 : 5, textAlign: "center" }}>
          <Avatar
            src={profileImage}
            sx={{
              width: isCompactHeight ? 80 : 100,
              height: isCompactHeight ? 80 : 100,
              mx: "auto",
              mb: isCompactHeight ? 1 : 3,
              backgroundColor: alpha("#3b82f6", 0.2),
              fontSize: isCompactHeight ? 24 : 32,
              fontWeight: 600,
              color: "#3b82f6",
            }}
          >
            D
          </Avatar>
          <Typography
            variant={isCompactHeight ? "h5" : "h4"}
            sx={{
              fontWeight: 600,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              mb: 1,
            }}
          >
            DoranekoSystems
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Security Researcher
          </Typography>
        </Box>

        {/* Favorites Section */}
        <Box sx={{ mb: 5 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
            <FavoriteIcon sx={{ color: "#ec4899" }} />
            <Typography variant="h6" sx={{ color: "#e5e7eb" }}>
              Favorites
            </Typography>
          </Stack>

          <Stack
            direction="row"
            spacing={2}
            justifyContent="center"
            flexWrap="wrap"
            useFlexGap
          >
            {favorites.map((item, index) => (
              <Card
                key={index}
                sx={{
                  backgroundColor: alpha("#1a1a1a", 0.8),
                  border: "1px solid #2d2d2d",
                  borderRadius: 2,
                  minWidth: isCompactHeight ? 100 : 140,
                  transition: "all 0.3s ease",
                  "&:hover": {
                    borderColor: item.color,
                    transform: "translateY(-2px)",
                  },
                }}
              >
                <CardContent
                  sx={{ textAlign: "center", py: isCompactHeight ? 1.5 : 3 }}
                >
                  <Box sx={{ color: item.color, mb: 1 }}>{item.icon}</Box>
                  <Typography variant="body2" sx={{ color: "#e5e7eb" }}>
                    {item.label}
                  </Typography>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>

        <Divider sx={{ borderColor: "#2d2d2d", my: 4 }} />

        {/* Experience Section */}
        <Box sx={{ mb: 5 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
            <WorkIcon sx={{ color: "#3b82f6" }} />
            <Typography variant="h6" sx={{ color: "#e5e7eb" }}>
              Experience
            </Typography>
          </Stack>

          <Stack spacing={isCompactHeight ? 1 : 2}>
            {experiences.map((exp, index) => (
              <Card
                key={index}
                sx={{
                  backgroundColor: alpha("#1a1a1a", 0.8),
                  border: "1px solid #2d2d2d",
                  borderRadius: 2,
                  transition: "all 0.3s ease",
                  "&:hover": {
                    borderColor: exp.color,
                  },
                }}
              >
                <CardContent sx={{ p: isCompactHeight ? 1.5 : undefined }}>
                  <Stack
                    direction="row"
                    spacing={isCompactHeight ? 2 : 3}
                    alignItems="center"
                  >
                    <Box
                      sx={{
                        width: isCompactHeight ? 44 : 60,
                        height: isCompactHeight ? 44 : 60,
                        borderRadius: 2,
                        backgroundColor: alpha(exp.color, 0.1),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: exp.color,
                        flexShrink: 0,
                        "& svg": {
                          fontSize: isCompactHeight ? 24 : 32,
                        },
                      }}
                    >
                      {exp.icon}
                    </Box>
                    <Box sx={{ flex: 1 }}>
                      <Typography
                        variant="h6"
                        sx={{
                          color: "#fff",
                          fontWeight: 500,
                          fontSize: "1rem",
                          mb: 0.5,
                        }}
                      >
                        {exp.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {exp.description}
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>

        <Divider sx={{ borderColor: "#2d2d2d", my: isCompactHeight ? 2 : 4 }} />

        {/* Contact Section */}
        <Box
          sx={{
            textAlign: "center",
            p: isCompactHeight ? 2 : 4,
            backgroundColor: alpha("#1a1a1a", 0.5),
            borderRadius: 2,
            border: "1px solid #2d2d2d",
          }}
        >
          <Typography
            variant="h6"
            sx={{ mb: isCompactHeight ? 1 : 2, color: "#e5e7eb" }}
          >
            Contact
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: isCompactHeight ? 1.5 : 3 }}
          >
            Want to chat? Feel free to reach out on X
          </Typography>
          <IconButton
            component="a"
            href="https://x.com/DoranekoSystems"
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              backgroundColor: alpha("#fff", 0.1),
              color: "#fff",
              width: isCompactHeight ? 44 : 56,
              height: isCompactHeight ? 44 : 56,
              transition: "all 0.3s ease",
              "&:hover": {
                backgroundColor: "#fff",
                color: "#000",
                transform: "scale(1.1)",
              },
            }}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </IconButton>
          <Typography
            variant="caption"
            display="block"
            sx={{ mt: 2, color: "#6b7280" }}
          >
            @DoranekoSystems
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};
