import React from "react";
import {
  Box,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Stack,
  alpha,
  useMediaQuery,
} from "@mui/material";
import {
  ExpandMore as ExpandMoreIcon,
  QuestionAnswer as QuestionAnswerIcon,
  Code as CodeIcon,
  Devices as DevicesIcon,
  Security as SecurityIcon,
  Favorite as FavoriteIcon,
} from "@mui/icons-material";

interface FAQItem {
  question: string;
  answer: string | React.ReactNode;
  icon?: React.ReactNode;
  tags?: string[];
}

const faqItems: FAQItem[] = [
  {
    question: "Is this project open source?",
    answer:
      "Yes! This project has been open source since January 7, 2026 under the GPL v3 license. Contributions are welcome — feel free to submit pull requests!",
    icon: <CodeIcon />,
    tags: ["Open Source", "License"],
  },
  {
    question: "What platforms and architectures are supported?",
    answer: (
      <Box>
        <Typography variant="body2" sx={{ mb: 2 }}>
          I plan to cover all major operating systems: Windows, Linux, macOS,
          Android, and iOS.
        </Typography>
        <Typography variant="body2">
          Major CPU architectures including x86, x86_64, and ARM64 are supported
          or planned.
        </Typography>
      </Box>
    ),
    icon: <DevicesIcon />,
    tags: ["Platform", "Architecture"],
  },
  {
    question: "Does DynaDbg depend on Frida, LLDB, or GDB?",
    answer: (
      <Box>
        <Typography variant="body2" sx={{ mb: 2 }}>
          <strong>No</strong>, DynaDbg is a completely independent tool. It does
          not rely on Frida, LLDB, GDB, or any other external debugging
          framework.
        </Typography>
        <Typography variant="body2">
          However, I may implement integration features with these tools in the
          future to enhance functionality and interoperability.
        </Typography>
      </Box>
    ),
    icon: <SecurityIcon />,
    tags: ["Independence", "Integration"],
  },
  {
    question: "How can I support the development?",
    answer: (
      <Box>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Please check out the{" "}
          <Box
            component="a"
            href="https://github.com/DoranekoSystems"
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              color: "#3b82f6",
              textDecoration: "none",
              fontWeight: 500,
              "&:hover": {
                textDecoration: "underline",
              },
            }}
          >
            GitHub page
          </Box>
          .
        </Typography>
        <Typography variant="body2">
          Your support helps me continue developing and improving DynaDbg.
        </Typography>
      </Box>
    ),
    icon: <FavoriteIcon />,
    tags: ["Support", "GitHub"],
  },
];

export const HelpContent: React.FC = () => {
  const [expanded, setExpanded] = React.useState<string | false>("panel0");

  // Compact mode for height < 800px
  const isCompactHeight = useMediaQuery("(max-height: 800px)");

  const handleChange =
    (panel: string) => (_event: React.SyntheticEvent, isExpanded: boolean) => {
      setExpanded(isExpanded ? panel : false);
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
          <QuestionAnswerIcon
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
            Frequently Asked Questions
          </Typography>
        </Stack>
        <Typography variant="body1" color="text.secondary">
          Find answers to common questions about DynaDbg
        </Typography>
      </Box>

      {/* FAQ Section */}
      <Box sx={{ maxWidth: 800, mx: "auto" }}>
        {faqItems.map((item, index) => (
          <Accordion
            key={index}
            expanded={expanded === `panel${index}`}
            onChange={handleChange(`panel${index}`)}
            sx={{
              backgroundColor: alpha("#1a1a1a", 0.8),
              border: "1px solid",
              borderColor: expanded === `panel${index}` ? "#3b82f6" : "#2d2d2d",
              borderRadius: "8px !important",
              mb: isCompactHeight ? 1 : 2,
              "&:before": {
                display: "none",
              },
              transition: "all 0.3s ease",
              "&:hover": {
                borderColor:
                  expanded === `panel${index}` ? "#3b82f6" : "#4a4a4a",
              },
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon sx={{ color: "#9ca3af" }} />}
              sx={{
                "& .MuiAccordionSummary-content": {
                  alignItems: "center",
                },
                py: 1,
              }}
            >
              <Stack
                direction="row"
                spacing={2}
                alignItems="center"
                sx={{ width: "100%" }}
              >
                <Box
                  sx={{
                    color: "#3b82f6",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {item.icon}
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontWeight: 500,
                      color: expanded === `panel${index}` ? "#fff" : "#e5e7eb",
                    }}
                  >
                    {item.question}
                  </Typography>
                  {item.tags && (
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                      {item.tags.map((tag, tagIndex) => (
                        <Chip
                          key={tagIndex}
                          label={tag}
                          size="small"
                          sx={{
                            height: 20,
                            fontSize: "10px",
                            backgroundColor: alpha("#3b82f6", 0.1),
                            color: "#60a5fa",
                            border: "none",
                          }}
                        />
                      ))}
                    </Stack>
                  )}
                </Box>
              </Stack>
            </AccordionSummary>
            <AccordionDetails
              sx={{
                backgroundColor: alpha("#0f0f0f", 0.5),
                borderTop: "1px solid #2d2d2d",
                pt: 2,
              }}
            >
              {typeof item.answer === "string" ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ lineHeight: 1.8 }}
                >
                  {item.answer}
                </Typography>
              ) : (
                item.answer
              )}
            </AccordionDetails>
          </Accordion>
        ))}
      </Box>

      {/* Contact Section */}
      <Box
        sx={{
          mt: isCompactHeight ? 3 : 6,
          p: isCompactHeight ? 2 : 3,
          maxWidth: 800,
          mx: "auto",
          backgroundColor: alpha("#1a1a1a", 0.5),
          borderRadius: 2,
          border: "1px solid #2d2d2d",
          textAlign: "center",
        }}
      >
        <Typography variant="h6" sx={{ mb: 1, color: "#e5e7eb" }}>
          Still have questions?
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Feel free to open an issue on{" "}
          <Box
            component="a"
            href="https://github.com/DoranekoSystems/DynaDbg"
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              color: "#3b82f6",
              textDecoration: "none",
              "&:hover": {
                textDecoration: "underline",
              },
            }}
          >
            GitHub
          </Box>
          .
        </Typography>
      </Box>
    </Box>
  );
};
