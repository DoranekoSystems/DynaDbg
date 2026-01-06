import React, { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Stack,
  Chip,
  alpha,
  useMediaQuery,
  CircularProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  Newspaper as NewsIcon,
  NewReleases as UpdateIcon,
  Info as InfoIcon,
  Warning as WarningIcon,
  Campaign as AnnouncementIcon,
  Launch as LaunchIcon,
  Refresh as RefreshIcon,
  CheckCircle as ReadIcon,
} from "@mui/icons-material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { NewsItem, NewsResponse } from "../lib/api";

const NEWS_READ_KEY = "dynadbg_news_read_ids";

// Hardcoded welcome news - always shown at the bottom
const WELCOME_NEWS: NewsItem = {
  id: "welcome-dynadbg",
  date: "2024-01-01",
  title: "Thanks for trying DynaDbg!",
  body: "Hi there! I hope this tool helps enhance your security research and learning journey.",
  type: "info",
  link: "",
};

const getTypeIcon = (type: NewsItem["type"]) => {
  switch (type) {
    case "update":
      return <UpdateIcon sx={{ fontSize: 24 }} />;
    case "warning":
      return <WarningIcon sx={{ fontSize: 24 }} />;
    case "announcement":
      return <AnnouncementIcon sx={{ fontSize: 24 }} />;
    case "info":
    default:
      return <InfoIcon sx={{ fontSize: 24 }} />;
  }
};

const getTypeColor = (type: NewsItem["type"]) => {
  switch (type) {
    case "update":
      return "#3b82f6"; // blue
    case "warning":
      return "#f59e0b"; // amber
    case "announcement":
      return "#8b5cf6"; // purple
    case "info":
    default:
      return "#10b981"; // green
  }
};

const getTypeLabel = (type: NewsItem["type"]) => {
  switch (type) {
    case "update":
      return "Update";
    case "warning":
      return "Warning";
    case "announcement":
      return "Announcement";
    case "info":
    default:
      return "Info";
  }
};

interface NewsContentProps {
  onUnreadCountChange?: (count: number) => void;
}

export const NewsContent: React.FC<NewsContentProps> = ({
  onUnreadCountChange,
}) => {
  const [newsData, setNewsData] = useState<NewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const isCompactHeight = useMediaQuery("(max-height: 800px)");

  // Load read news IDs from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(NEWS_READ_KEY);
      if (stored) {
        setReadIds(new Set(JSON.parse(stored)));
      }
    } catch (e) {
      console.error("Failed to load read news IDs:", e);
    }
  }, []);

  // Fetch news data
  const fetchNews = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("https://news.dynadbg.com/public/news.json");
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }
      const data: NewsResponse = await response.json();
      setNewsData(data);
    } catch (e) {
      // On error, still show welcome news with empty fetched news
      setNewsData({
        latest_version: "1.0.0",
        force_update: false,
        news: [],
      });
      console.error("Failed to fetch news:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNews();
  }, [fetchNews]);

  // Mark all news as read when component mounts
  useEffect(() => {
    if (newsData?.news) {
      const allIds = new Set(newsData.news.map((item) => item.id));
      const newReadIds = new Set([...readIds, ...allIds]);
      setReadIds(newReadIds);
      localStorage.setItem(NEWS_READ_KEY, JSON.stringify([...newReadIds]));
    }
  }, [newsData]);

  // Calculate unread count and notify parent
  useEffect(() => {
    if (newsData?.news && onUnreadCountChange) {
      const unreadCount = newsData.news.filter(
        (item) => !readIds.has(item.id)
      ).length;
      onUnreadCountChange(unreadCount);
    }
  }, [newsData, readIds, onUnreadCountChange]);

  const handleLinkClick = async (url: string) => {
    if (!url) return;
    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open URL:", error);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
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
      <Box
        sx={{
          mb: isCompactHeight ? 2 : 4,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <Stack
          direction="row"
          justifyContent="center"
          alignItems="center"
          spacing={1.5}
          sx={{ mb: 1 }}
        >
          <NewsIcon sx={{ fontSize: 32, color: "#3b82f6" }} />
          <Typography
            variant="h4"
            sx={{
              fontWeight: 700,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            News & Updates
          </Typography>
          <Tooltip title="Refresh">
            <IconButton
              onClick={fetchNews}
              disabled={loading}
              sx={{
                color: alpha("#fff", 0.5),
                "&:hover": { color: "#3b82f6" },
              }}
            >
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Stack>
        <Typography
          variant="body2"
          sx={{
            color: alpha("#fff", 0.6),
            maxWidth: 500,
          }}
        >
          Stay updated with the latest news, updates, and announcements
        </Typography>
      </Box>

      {/* Loading State */}
      {loading && (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            py: 8,
          }}
        >
          <CircularProgress size={40} sx={{ color: "#3b82f6" }} />
        </Box>
      )}

      {/* Error State */}
      {error && !loading && (
        <Box
          sx={{
            textAlign: "center",
            py: 8,
          }}
        >
          <Typography color="error">{error}</Typography>
        </Box>
      )}

      {/* News List */}
      {!loading && newsData && (
        <Stack spacing={2}>
          {/* Fetched news from server */}
          {newsData.news.map((item) => {
            const color = getTypeColor(item.type);
            const isRead = readIds.has(item.id);

            return (
              <Card
                key={item.id}
                sx={{
                  backgroundColor: alpha("#1a1a1a", 0.8),
                  backgroundImage: "none",
                  border: "1px solid",
                  borderColor: alpha(color, 0.2),
                  borderRadius: 2,
                  transition: "all 0.2s ease",
                  position: "relative",
                  "&:hover": {
                    borderColor: alpha(color, 0.4),
                    transform: "translateY(-2px)",
                    boxShadow: `0 8px 24px ${alpha(color, 0.15)}`,
                  },
                }}
              >
                <CardContent sx={{ p: isCompactHeight ? 2 : 3 }}>
                  <Stack spacing={1.5}>
                    {/* Header */}
                    <Stack
                      direction="row"
                      alignItems="flex-start"
                      justifyContent="space-between"
                    >
                      <Stack direction="row" spacing={2} alignItems="center">
                        <Box
                          sx={{
                            width: 44,
                            height: 44,
                            borderRadius: 2,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: alpha(color, 0.15),
                            color: color,
                          }}
                        >
                          {getTypeIcon(item.type)}
                        </Box>
                        <Box>
                          <Typography
                            variant="h6"
                            sx={{
                              fontWeight: 600,
                              color: "#fff",
                              fontSize: "1rem",
                            }}
                          >
                            {item.title}
                          </Typography>
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ mt: 0.5 }}
                          >
                            <Chip
                              label={getTypeLabel(item.type)}
                              size="small"
                              sx={{
                                backgroundColor: alpha(color, 0.15),
                                color: color,
                                fontWeight: 500,
                                fontSize: "0.7rem",
                                height: 20,
                              }}
                            />
                            <Typography
                              variant="caption"
                              sx={{ color: alpha("#fff", 0.5) }}
                            >
                              {formatDate(item.date)}
                            </Typography>
                            {isRead && (
                              <Tooltip title="Read">
                                <ReadIcon
                                  sx={{
                                    fontSize: 14,
                                    color: alpha("#fff", 0.3),
                                  }}
                                />
                              </Tooltip>
                            )}
                          </Stack>
                        </Box>
                      </Stack>

                      {item.link && (
                        <Tooltip title="Open link">
                          <IconButton
                            onClick={() => handleLinkClick(item.link)}
                            sx={{
                              color: alpha("#fff", 0.5),
                              "&:hover": { color: color },
                            }}
                          >
                            <LaunchIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>

                    {/* Body */}
                    <Typography
                      variant="body2"
                      sx={{
                        color: alpha("#fff", 0.7),
                        lineHeight: 1.7,
                        pl: 7,
                      }}
                    >
                      {item.body}
                    </Typography>
                  </Stack>
                </CardContent>
              </Card>
            );
          })}

          {/* Hardcoded Welcome News - always shown at the bottom */}
          {(() => {
            const color = getTypeColor(WELCOME_NEWS.type);
            return (
              <Card
                key={WELCOME_NEWS.id}
                sx={{
                  backgroundColor: alpha("#1a1a1a", 0.8),
                  backgroundImage: "none",
                  border: "1px solid",
                  borderColor: alpha(color, 0.2),
                  borderRadius: 2,
                  transition: "all 0.2s ease",
                  position: "relative",
                  "&:hover": {
                    borderColor: alpha(color, 0.4),
                    transform: "translateY(-2px)",
                    boxShadow: `0 8px 24px ${alpha(color, 0.15)}`,
                  },
                }}
              >
                <CardContent sx={{ p: isCompactHeight ? 2 : 3 }}>
                  <Stack spacing={1.5}>
                    <Stack
                      direction="row"
                      alignItems="flex-start"
                      justifyContent="space-between"
                    >
                      <Stack direction="row" spacing={2} alignItems="center">
                        <Box
                          sx={{
                            width: 44,
                            height: 44,
                            borderRadius: 2,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: alpha(color, 0.15),
                            color: color,
                          }}
                        >
                          {getTypeIcon(WELCOME_NEWS.type)}
                        </Box>
                        <Box>
                          <Typography
                            variant="h6"
                            sx={{
                              fontWeight: 600,
                              color: "#fff",
                              fontSize: "1rem",
                            }}
                          >
                            {WELCOME_NEWS.title}
                          </Typography>
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ mt: 0.5 }}
                          >
                            <Chip
                              label={getTypeLabel(WELCOME_NEWS.type)}
                              size="small"
                              sx={{
                                backgroundColor: alpha(color, 0.15),
                                color: color,
                                fontWeight: 500,
                                fontSize: "0.7rem",
                                height: 20,
                              }}
                            />
                          </Stack>
                        </Box>
                      </Stack>
                    </Stack>

                    <Typography
                      variant="body2"
                      sx={{
                        color: alpha("#fff", 0.7),
                        lineHeight: 1.7,
                        pl: 7,
                      }}
                    >
                      {WELCOME_NEWS.body}
                    </Typography>
                  </Stack>
                </CardContent>
              </Card>
            );
          })()}
        </Stack>
      )}
    </Box>
  );
};

// Helper hook to get unread news count
export const useUnreadNewsCount = (): number => {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const checkUnread = async () => {
      try {
        const response = await fetch(
          "https://news.dynadbg.com/public/news.json"
        );
        if (!response.ok) {
          setUnreadCount(0);
          return;
        }
        const data: NewsResponse = await response.json();
        const stored = localStorage.getItem(NEWS_READ_KEY);
        const readIds = stored ? new Set(JSON.parse(stored)) : new Set();
        const count = data.news.filter(
          (item: NewsItem) => !readIds.has(item.id)
        ).length;
        setUnreadCount(count);
      } catch (e) {
        console.error("Failed to check unread news:", e);
        setUnreadCount(0);
      }
    };

    checkUnread();
  }, []);

  return unreadCount;
};
