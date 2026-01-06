import React from "react";
import {
  Box,
  Container,
  Typography,
  Stack,
  IconButton,
  Divider,
  useTheme,
} from "@mui/material";
import { GitHub } from "@mui/icons-material";

const TwitterIcon = (props: any) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path
      fill="currentColor"
      d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
    />
  </svg>
);

interface FooterProps {
  onAboutClick?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onAboutClick }) => {
  const theme = useTheme();

  return (
    <Box
      sx={{
        backgroundColor: theme.palette.background.paper,
        py: 4,
        mt: 8,
        borderTop: 1,
        borderColor: "divider",
      }}
    >
      <Container maxWidth="lg">
        <Stack spacing={3} alignItems="center">
          <Typography variant="body2" color="text.secondary" fontWeight="500">
            Created by Kenjiro Ichise
          </Typography>

          <Stack direction="row" spacing={3}>
            <IconButton
              component="a"
              href="https://twitter.com/DoranekoSystems"
              target="_blank"
              rel="noopener noreferrer"
              color="inherit"
              sx={{
                color: "text.secondary",
                "&:hover": {
                  color: "primary.main",
                  transform: "translateY(-2px)",
                },
                transition: "all 0.2s",
              }}
            >
              <TwitterIcon width={20} height={20} />
            </IconButton>

            <IconButton
              component="a"
              href="https://github.com/DoranekoSystems"
              target="_blank"
              rel="noopener noreferrer"
              color="inherit"
              sx={{
                color: "text.secondary",
                "&:hover": {
                  color: "primary.main",
                  transform: "translateY(-2px)",
                },
                transition: "all 0.2s",
              }}
            >
              <GitHub />
            </IconButton>
          </Stack>

          <Divider sx={{ width: "100%" }} />

          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems="center"
            width="100%"
            spacing={2}
          >
            <Typography variant="caption" color="text.disabled">
              © 2025{" "}
              <Typography
                component="span"
                variant="caption"
                sx={{
                  cursor: "pointer",
                  color: "text.disabled",
                  "&:hover": { color: "primary.main" },
                  transition: "color 0.2s",
                }}
                onClick={onAboutClick}
              >
                DoranekoSystems
              </Typography>
              . All rights reserved.
            </Typography>
            <Stack direction="row" spacing={3}>
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{
                  cursor: "pointer",
                  "&:hover": { color: "text.secondary" },
                  transition: "color 0.2s",
                }}
              >
                Privacy Policy
              </Typography>
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{
                  cursor: "pointer",
                  "&:hover": { color: "text.secondary" },
                  transition: "color 0.2s",
                }}
              >
                Terms of Service
              </Typography>
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{
                  cursor: "pointer",
                  "&:hover": { color: "text.secondary" },
                  transition: "color 0.2s",
                }}
              >
                Documentation
              </Typography>
            </Stack>
          </Stack>
        </Stack>
      </Container>
    </Box>
  );
};
