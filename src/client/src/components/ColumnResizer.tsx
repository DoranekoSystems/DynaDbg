import React from "react";
import { Box, styled } from "@mui/material";

interface ColumnResizerProps {
  onMouseDown: (e: React.MouseEvent) => void;
  isResizing?: boolean;
}

const ResizerHandle = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  position: "absolute",
  right: 0,
  top: "4px",
  bottom: "4px",
  width: "1px",
  cursor: "col-resize",
  backgroundColor: isResizing ? "#4fc1ff" : "#3a3a3a",
  transition: "background-color 0.15s ease",
  zIndex: 10,
  "&:hover": {
    backgroundColor: "#4fc1ff",
  },
  "&::before": {
    content: '""',
    position: "absolute",
    top: "-4px",
    left: "-3px",
    width: "8px",
    height: "calc(100% + 8px)",
  },
}));

export const ColumnResizer: React.FC<ColumnResizerProps> = ({
  onMouseDown,
  isResizing = false,
}) => {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMouseDown(e);
  };

  return (
    <ResizerHandle onMouseDown={handleMouseDown} isResizing={isResizing} />
  );
};
