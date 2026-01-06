import React from "react";
import { Box, Typography, Button, alpha, Stack } from "@mui/material";
import {
  Security as SecurityIcon,
  CheckCircleOutline as CheckIcon,
  Block as BlockIcon,
  Info as InfoIcon,
} from "@mui/icons-material";
import dynadbgIcon from "../assets/dynadbg-icon.png";

interface LicenseAgreementDialogProps {
  open: boolean;
  onAgree: () => void;
  onDisagree: () => void;
}

export const LicenseAgreementDialog: React.FC<LicenseAgreementDialogProps> = ({
  open,
  onAgree,
  onDisagree,
}) => {
  if (!open) return null;

  return (
    <Box
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        zIndex: 9999,
      }}
    >
      {/* Background grid */}
      <Box
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundImage: `
            linear-gradient(rgba(59, 130, 246, 0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(59, 130, 246, 0.02) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
        }}
      />

      {/* Glowing orbs */}
      <Box
        sx={{
          position: "absolute",
          top: "15%",
          left: "10%",
          width: 300,
          height: 300,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(59, 130, 246, 0.08) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          bottom: "10%",
          right: "10%",
          width: 250,
          height: 250,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(139, 92, 246, 0.08) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      {/* Main content */}
      <Box
        sx={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 560,
          mx: 3,
        }}
      >
        {/* Card */}
        <Box
          sx={{
            background:
              "linear-gradient(145deg, rgba(26, 26, 26, 0.95) 0%, rgba(15, 15, 15, 0.98) 100%)",
            borderRadius: 3,
            border: "1px solid",
            borderColor: alpha("#3b82f6", 0.15),
            overflow: "hidden",
            boxShadow: `
              0 0 0 1px ${alpha("#000", 0.5)},
              0 20px 50px ${alpha("#000", 0.5)},
              0 0 100px ${alpha("#3b82f6", 0.1)}
            `,
          }}
        >
          {/* Header */}
          <Box
            sx={{
              px: 4,
              py: 3,
              display: "flex",
              alignItems: "center",
              gap: 2,
              borderBottom: "1px solid",
              borderColor: alpha("#fff", 0.06),
              background: `linear-gradient(90deg, ${alpha("#3b82f6", 0.05)} 0%, transparent 100%)`,
            }}
          >
            <Box
              component="img"
              src={dynadbgIcon}
              alt="DynaDbg"
              sx={{
                width: 40,
                height: 40,
                filter: "drop-shadow(0 0 10px rgba(59, 130, 246, 0.3))",
              }}
            />
            <Box>
              <Typography
                variant="h6"
                sx={{
                  fontWeight: 600,
                  color: "#fff",
                  letterSpacing: "0.02em",
                }}
              >
                End User License Agreement
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: alpha("#fff", 0.4),
                  letterSpacing: "0.05em",
                }}
              >
                Please read before continuing
              </Typography>
            </Box>
          </Box>

          {/* Content */}
          <Box sx={{ px: 4, py: 3 }}>
            <Stack spacing={2.5}>
              {/* Item 1 */}
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  p: 2,
                  borderRadius: 2,
                  background: alpha("#3b82f6", 0.05),
                  border: "1px solid",
                  borderColor: alpha("#3b82f6", 0.1),
                }}
              >
                <SecurityIcon
                  sx={{
                    color: "#3b82f6",
                    fontSize: 22,
                    mt: 0.25,
                  }}
                />
                <Typography
                  variant="body2"
                  sx={{
                    color: alpha("#fff", 0.85),
                    lineHeight: 1.7,
                    fontSize: "0.875rem",
                  }}
                >
                  This software is intended solely for{" "}
                  <strong style={{ color: "#3b82f6" }}>
                    security research
                  </strong>
                  , debugging, education, and authorized system diagnostics.
                </Typography>
              </Box>

              {/* Item 2 */}
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  p: 2,
                  borderRadius: 2,
                  background: alpha("#ef4444", 0.05),
                  border: "1px solid",
                  borderColor: alpha("#ef4444", 0.1),
                }}
              >
                <BlockIcon
                  sx={{
                    color: "#ef4444",
                    fontSize: 22,
                    mt: 0.25,
                  }}
                />
                <Typography
                  variant="body2"
                  sx={{
                    color: alpha("#fff", 0.85),
                    lineHeight: 1.7,
                    fontSize: "0.875rem",
                  }}
                >
                  The use of this software to{" "}
                  <strong style={{ color: "#ef4444" }}>
                    infringe upon the rights of others
                  </strong>{" "}
                  (including copyright infringement, unauthorized access, etc.)
                  is strictly prohibited.
                </Typography>
              </Box>

              {/* Item 3 */}
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  p: 2,
                  borderRadius: 2,
                  background: alpha("#f59e0b", 0.05),
                  border: "1px solid",
                  borderColor: alpha("#f59e0b", 0.1),
                }}
              >
                <InfoIcon
                  sx={{
                    color: "#f59e0b",
                    fontSize: 22,
                    mt: 0.25,
                  }}
                />
                <Typography
                  variant="body2"
                  sx={{
                    color: alpha("#fff", 0.85),
                    lineHeight: 1.7,
                    fontSize: "0.875rem",
                  }}
                >
                  The developer assumes{" "}
                  <strong style={{ color: "#f59e0b" }}>
                    no responsibility
                  </strong>{" "}
                  for any damages arising from the use of this software.
                </Typography>
              </Box>
            </Stack>
          </Box>

          {/* Footer */}
          <Box
            sx={{
              px: 4,
              py: 3,
              display: "flex",
              gap: 2,
              borderTop: "1px solid",
              borderColor: alpha("#fff", 0.06),
              background: alpha("#000", 0.2),
            }}
          >
            <Button
              onClick={onDisagree}
              fullWidth
              sx={{
                py: 1.5,
                color: alpha("#fff", 0.6),
                borderRadius: 2,
                border: "1px solid",
                borderColor: alpha("#fff", 0.1),
                background: "transparent",
                textTransform: "none",
                fontWeight: 500,
                "&:hover": {
                  borderColor: alpha("#fff", 0.2),
                  background: alpha("#fff", 0.03),
                },
              }}
            >
              Decline
            </Button>
            <Button
              onClick={onAgree}
              fullWidth
              startIcon={<CheckIcon />}
              sx={{
                py: 1.5,
                color: "#fff",
                borderRadius: 2,
                background: "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)",
                textTransform: "none",
                fontWeight: 600,
                boxShadow: `0 4px 20px ${alpha("#3b82f6", 0.3)}`,
                "&:hover": {
                  background:
                    "linear-gradient(135deg, #2563eb 0%, #1e40af 100%)",
                  boxShadow: `0 6px 25px ${alpha("#3b82f6", 0.4)}`,
                },
              }}
            >
              I Agree
            </Button>
          </Box>
        </Box>

        {/* Version */}
        <Typography
          variant="caption"
          sx={{
            display: "block",
            textAlign: "center",
            mt: 3,
            color: alpha("#fff", 0.25),
            fontSize: "0.7rem",
          }}
        >
          DynaDbg © 2025 DoranekoSystems
        </Typography>
      </Box>
    </Box>
  );
};
