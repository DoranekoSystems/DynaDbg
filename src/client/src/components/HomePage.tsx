import React, { useRef, useEffect, useState } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  styled,
  alpha,
  Container,
  Stack,
  IconButton,
  useMediaQuery,
} from "@mui/material";
import {
  Check as CheckIcon,
  NetworkCheck as NetworkIcon,
  PlayArrow as PlayArrowIcon,
  GitHub as GitHubIcon,
  Public as PublicIcon,
} from "@mui/icons-material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ServerInfo, ProcessInfo, AppInfo } from "../lib/api";

import topImage from "../assets/top-img.png";
import demoVideo from "../assets/dynadbg-demo.mp4";

const TwitterIcon = (props: any) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path
      fill="currentColor"
      d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
    />
  </svg>
);

const HeroSection = styled(Box)(({ theme }) => ({
  background: "linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)",
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: theme.spacing(2),
  position: "relative",
  overflow: "hidden",
  "&::before": {
    content: '""',
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background:
      "radial-gradient(circle at 30% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 50%), radial-gradient(circle at 70% 80%, rgba(139, 92, 246, 0.1) 0%, transparent 50%)",
    pointerEvents: "none",
  },
}));

const GradientButton = styled(Button)(({ theme }) => ({
  background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
  color: "white",
  fontWeight: 300,
  borderRadius: theme.spacing(2),
  padding: theme.spacing(1.5, 4),
  textTransform: "none",
  fontSize: "1.1rem",
  "&:hover": {
    background: "linear-gradient(135deg, #1d4ed8, #1e40af)",
    transform: "translateY(-2px)",
    boxShadow: "0 8px 25px rgba(59, 130, 246, 0.3)",
  },
  transition: "all 0.3s ease",
}));

interface HomePageProps {
  serverConnected: boolean;
  serverInfo?: ServerInfo;
  attachedProcess?: ProcessInfo;
  attachedAppInfo?: AppInfo;
  onModeChange: (mode: "server" | "debugger" | "scanner") => void;
  onConnect?: () => void;
  onAttachProcess?: () => void;
  onDetachProcess?: () => void;
  onAboutClick?: () => void;
  connectionHost: string;
  connectionPort: number;
  isConnecting?: boolean;
}

export const HomePage: React.FC<HomePageProps> = ({
  serverConnected,
  onConnect,
  onAboutClick,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playCount, setPlayCount] = useState(0);
  const [videoError, setVideoError] = useState(false);
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);
  const playPromiseRef = useRef<Promise<void> | null>(null);

  // Media query for height threshold - hide content when height is less than 600px
  const isCompactHeight = useMediaQuery("(max-height: 800px)");

  const handleVideoClick = async () => {
    const video = videoRef.current;
    if (!video || videoError) return;

    if (video.paused) {
      setIsManuallyPaused(false);

      if (playPromiseRef.current) {
        try {
          await playPromiseRef.current;
        } catch (e) {
          /* ignore */
        }
      }

      try {
        playPromiseRef.current = video.play();
        await playPromiseRef.current;
      } catch (error: any) {
        if (error.name !== "AbortError") {
          console.error("Manual video play failed:", error);
        }
      } finally {
        playPromiseRef.current = null;
      }
    } else {
      setIsManuallyPaused(true);

      if (playPromiseRef.current) {
        try {
          await playPromiseRef.current;
        } catch (e) {
          /* ignore */
        }
        playPromiseRef.current = null;
      }

      video.pause();
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.playbackRate = 0.7;
    video.volume = 0;
    video.muted = true;

    const handleEnded = () => {
      setPlayCount((prev) => {
        const newCount = prev + 1;
        if (newCount < 2) {
          setTimeout(() => {
            video.currentTime = 0;
            if (!playPromiseRef.current) {
              playPromiseRef.current = video.play().catch((error) => {
                console.error("Video replay failed:", error);
                setVideoError(true);
              });
              if (playPromiseRef.current) {
                playPromiseRef.current.finally(() => {
                  playPromiseRef.current = null;
                });
              }
            }
          }, 500);
        }
        return newCount;
      });
    };

    const handleCanPlay = () => {
      if (playCount < 2 && !videoError) {
        setTimeout(() => {
          if (!playPromiseRef.current) {
            playPromiseRef.current = video.play().catch((error) => {
              console.error("Video play failed:", error);
              setVideoError(true);
            });
            if (playPromiseRef.current) {
              playPromiseRef.current.finally(() => {
                playPromiseRef.current = null;
              });
            }
          }
        }, 100);
      }
    };

    const handleLoadedData = () => {
      if (playCount < 2 && !videoError) {
        if (!playPromiseRef.current) {
          playPromiseRef.current = video.play().catch((error) => {
            console.error("Video play from loadeddata failed:", error);
            setVideoError(true);
          });
          if (playPromiseRef.current) {
            playPromiseRef.current.finally(() => {
              playPromiseRef.current = null;
            });
          }
        }
      }
    };

    const handleError = (event: Event) => {
      console.error("Video loading error:", event);
      setVideoError(true);
    };

    const handleLoadedMetadata = () => {};

    const handlePlay = () => {};

    const handlePause = () => {};

    video.addEventListener("ended", handleEnded);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("error", handleError);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (
            entry.isIntersecting &&
            playCount < 2 &&
            !videoError &&
            !isManuallyPaused
          ) {
            if (video.readyState >= 2 && !playPromiseRef.current) {
              playPromiseRef.current = video.play().catch((error) => {
                console.error("Video play from intersection failed:", error);
                setVideoError(true);
              });
              if (playPromiseRef.current) {
                playPromiseRef.current.finally(() => {
                  playPromiseRef.current = null;
                });
              }
            }
          } else if (
            !entry.isIntersecting &&
            !isManuallyPaused &&
            !playPromiseRef.current
          ) {
            video.pause();
          }
        });
      },
      {
        root: null,
        rootMargin: "50px",
        threshold: 0.3,
      }
    );

    observer.observe(video);

    setTimeout(() => {
      if (
        playCount === 0 &&
        !videoError &&
        video.readyState >= 2 &&
        !playPromiseRef.current
      ) {
        playPromiseRef.current = video.play().catch(() => {
          setVideoError(true);
        });
        if (playPromiseRef.current) {
          playPromiseRef.current.finally(() => {
            playPromiseRef.current = null;
          });
        }
      }
    }, 500);

    return () => {
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("error", handleError);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      observer.disconnect();
    };
  }, [playCount, videoError, isManuallyPaused]);

  const handleOpenDynaDbgWebsite = async () => {
    try {
      await openUrl("https://dynadbg.com");
    } catch (error) {
      console.error("Failed to open dynadbg.com:", error);
    }
  };

  const getStatusChip = () => {
    return (
      <Chip
        icon={<PublicIcon sx={{ fontSize: "16px" }} />}
        label="Remote Dynamic Analysis Platform"
        color="primary"
        variant="outlined"
        onClick={handleOpenDynaDbgWebsite}
        sx={{
          cursor: "pointer",
          transition: "all 0.2s ease",
          "&:hover": {
            backgroundColor: "rgba(59, 130, 246, 0.15)",
            borderColor: "primary.light",
            transform: "scale(1.02)",
          },
        }}
      />
    );
  };

  const getMainDescription = () => {
    return (
      "Perform comprehensive dynamic analysis on remote systems with real-time monitoring,\n" +
      "memory inspection, and vulnerability scanning from anywhere."
    );
  };
  const getActionButton = () => {
    if (!serverConnected) {
      return (
        <GradientButton startIcon={<NetworkIcon />} onClick={onConnect}>
          Connect to Target
        </GradientButton>
      );
    }
  };

  return (
    <Box
      sx={{
        height: "100vh",
        bgcolor: "#0f0f0f",
        color: "white",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Hero Section */}
      <HeroSection>
        <Box
          sx={{ position: "relative", zIndex: 1, maxWidth: "4xl", mx: "auto" }}
        >
          <Box sx={{ mb: 2 }}>{getStatusChip()}</Box>

          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: "2.5rem", md: "3.5rem" },
              fontWeight: 100,
              letterSpacing: "wide",
              mb: 2,
              background: "linear-gradient(135deg, #ffffff, #a1a1aa)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              color: "transparent",
            }}
          >
            DynaDbg
          </Typography>

          <Typography
            variant="h3"
            sx={{
              fontSize: { xs: "1.2rem", md: "1.6rem" },
              fontWeight: 300,
              letterSpacing: "wide",
              mb: 3,
              color: "#a1a1aa",
            }}
          >
            Next-Generation Remote Analysis Suite
          </Typography>

          <Box
            sx={{
              width: 100,
              height: 2,
              bgcolor: "#3b82f6",
              mx: "auto",
              mb: 3,
            }}
          />

          <Typography
            variant="h6"
            sx={{
              fontSize: { xs: "1rem", md: "1.1rem" },
              fontWeight: 300,
              lineHeight: 1.6,
              maxWidth: "2xl",
              mx: "auto",
              mb: 4,
              color: "#d1d5db",
              whiteSpace: "pre-line",
            }}
          >
            {getMainDescription()}
          </Typography>

          {getActionButton()}
        </Box>
      </HeroSection>

      {/* Remote Analysis Features - Hidden on compact height */}
      {!isCompactHeight && (
        <Box sx={{ py: 3, px: 3, bgcolor: "#1a1a1a", flexShrink: 0 }}>
          <Box sx={{ maxWidth: "7xl", mx: "auto" }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
                gap: 4,
                alignItems: "center",
              }}
            >
              <Box>
                <Typography
                  variant="h2"
                  sx={{
                    fontSize: { xs: "1.8rem", md: "2.5rem" },
                    fontWeight: 300,
                    letterSpacing: "wide",
                    mb: 2,
                    color: "white",
                  }}
                >
                  Advanced Remote Analysis
                </Typography>
                <Typography
                  variant="h6"
                  sx={{
                    fontSize: "1.1rem",
                    fontWeight: 300,
                    lineHeight: 1.6,
                    mb: 3,
                    color: "#d1d5db",
                  }}
                >
                  Break through the barriers of traditional debugging. Analyze
                  systems across networks with robust security and real-time
                  performance.
                </Typography>
                <Box
                  sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}
                >
                  {[
                    "High-speed memory scanning",
                    "Cross-platform remote debugging",
                    "Multi-target simultaneous analysis",
                    "Fully native debugger independent of gdb/lldb",
                  ].map((feature, index) => (
                    <Box
                      key={index}
                      sx={{ display: "flex", alignItems: "center", gap: 2 }}
                    >
                      <CheckIcon sx={{ color: "#3b82f6" }} />
                      <Typography sx={{ color: "#d1d5db", fontWeight: 300 }}>
                        {feature}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Box>

              <Box
                sx={{
                  width: "100%",
                  height: 300,
                  borderRadius: 3,
                  border: "1px solid",
                  borderColor: alpha("#3b82f6", 0.2),
                  overflow: "hidden",
                  bgcolor: "#1e1e1e",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.3)",
                }}
              >
                {playCount >= 1 || videoError ? (
                  <Box
                    component="img"
                    src={topImage}
                    alt="DynaDbg Screenshot"
                    onClick={() => {
                      setPlayCount(0);
                      setVideoError(false);
                      setIsManuallyPaused(false);
                    }}
                    sx={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      cursor: "pointer",
                    }}
                  />
                ) : (
                  <Box
                    component="video"
                    ref={videoRef}
                    onClick={handleVideoClick}
                    sx={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      cursor: "pointer",
                    }}
                    muted
                    playsInline
                    preload="auto"
                    loop={false}
                    controls={false}
                    autoPlay={false}
                  >
                    <source src={demoVideo} type="video/mp4" />
                    <Box
                      sx={{
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: 2,
                        color: "#d1d5db",
                      }}
                    >
                      <PlayArrowIcon sx={{ fontSize: 64, color: "#3b82f6" }} />
                      <Typography variant="h6" sx={{ fontWeight: 500 }}>
                        DynaDbg Demo Video
                      </Typography>
                      <Typography variant="body2" sx={{ color: "#6b7280" }}>
                        Your browser doesn't support video playback
                      </Typography>
                    </Box>
                  </Box>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      )}

      {/* Footer Section */}
      <Box
        sx={{
          py: 1.5,
          px: 3,
          mt: "auto",
          borderTop: "1px solid #374151",
          bgcolor: "#1a1a1a",
          flexShrink: 0,
          minHeight: "120px",
        }}
      >
        <Container maxWidth="md">
          <Stack spacing={0.5} alignItems="center">
            <Typography variant="body2" color="#d1d5db" fontWeight="500">
              Created by{" "}
              <Typography
                component="span"
                variant="body2"
                sx={{
                  cursor: "pointer",
                  fontWeight: 500,
                  color: "#d1d5db",
                  "&:hover": {
                    color: "#3b82f6",
                    textDecoration: "underline",
                    textUnderlineOffset: "2px",
                  },
                  transition: "color 0.2s",
                }}
                onClick={onAboutClick}
              >
                DoranekoSystems
              </Typography>
            </Typography>

            <Stack direction="row" spacing={3} sx={{ py: 0 }}>
              <IconButton
                component="a"
                href="https://twitter.com/DoranekoSystems"
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  color: "#d1d5db",
                  width: 36,
                  height: 36,
                  "&:hover": {
                    color: "#3b82f6",
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
                sx={{
                  color: "#d1d5db",
                  width: 36,
                  height: 36,
                  "&:hover": {
                    color: "#3b82f6",
                    transform: "translateY(-2px)",
                  },
                  transition: "all 0.2s",
                }}
              >
                <GitHubIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Stack>
          </Stack>
        </Container>
      </Box>
    </Box>
  );
};
