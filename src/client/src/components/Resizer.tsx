import React from "react";
import { Box, styled } from "@mui/material";

interface ResizerProps {
  orientation?: "horizontal" | "vertical";
  onMouseDown: (e: React.MouseEvent) => void;
  isResizing?: boolean;
}

const HorizontalResizer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  width: "100%",
  height: "4px",
  backgroundColor: isResizing ? "#4fc1ff" : "transparent",
  cursor: "ns-resize",
  position: "relative",
  transition: "background-color 0.15s ease",
  zIndex: 10,
  "&:hover": {
    backgroundColor: "#4fc1ff",
  },
  "&::before": {
    content: '""',
    position: "absolute",
    top: "-2px",
    left: 0,
    right: 0,
    height: "8px",
  },
}));

const VerticalResizer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  width: "4px",
  height: "100%",
  backgroundColor: isResizing ? "#4fc1ff" : "transparent",
  cursor: "ew-resize",
  position: "relative",
  transition: "background-color 0.15s ease",
  zIndex: 10,
  "&:hover": {
    backgroundColor: "#4fc1ff",
  },
  "&::before": {
    content: '""',
    position: "absolute",
    top: 0,
    left: "-2px",
    width: "8px",
    height: "100%",
  },
}));

export const Resizer: React.FC<ResizerProps> = ({
  orientation = "vertical",
  onMouseDown,
  isResizing = false,
}) => {
  if (orientation === "horizontal") {
    return (
      <HorizontalResizer onMouseDown={onMouseDown} isResizing={isResizing} />
    );
  }

  return <VerticalResizer onMouseDown={onMouseDown} isResizing={isResizing} />;
};
