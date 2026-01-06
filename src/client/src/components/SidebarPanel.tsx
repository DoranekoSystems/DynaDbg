import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Collapse,
  styled,
} from "@mui/material";
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from "@mui/icons-material";

interface SidebarPanelAction {
  icon: React.ReactNode;
  tooltip: string;
  onClick: () => void;
}

interface SidebarPanelProps {
  title: string;
  icon?: React.ComponentType;
  badge?: string;
  actions?: SidebarPanelAction[];
  defaultExpanded?: boolean;
  // Controlled mode props
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  // Optional height control
  height?: number | string;
  minHeight?: number;
  children: React.ReactNode;
}

const PanelContainer = styled(Box)(() => ({
  borderBottom: "1px solid",
  borderColor: "#2d2d30",
  backgroundColor: "transparent",
}));

const PanelHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  padding: "4px 8px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #2d2d30",
  cursor: "pointer",
  minHeight: "24px",
  "&:hover": {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
  },
  "@media (max-height: 800px)": {
    padding: "3px 8px",
    minHeight: "20px",
  },
}));

const PanelTitle = styled(Typography)(() => ({
  color: "#4fc1ff",
  fontWeight: 600,
  fontSize: "10px",
  flex: 1,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  "@media (max-height: 800px)": {
    fontSize: "9px",
  },
}));

const PanelIcon = styled(Box)(() => ({
  color: "#4fc1ff",
  display: "flex",
  alignItems: "center",
  marginRight: "6px",
  "& .MuiSvgIcon-root": {
    fontSize: "12px",
    "@media (max-height: 800px)": {
      fontSize: "10px",
    },
  },
}));

const PanelBadge = styled(Typography)(() => ({
  backgroundColor: "rgba(79, 193, 255, 0.15)",
  color: "#4fc1ff",
  borderRadius: "4px",
  padding: "0px 4px",
  fontSize: "9px",
  fontWeight: 600,
  marginRight: "4px",
  "@media (max-height: 800px)": {
    fontSize: "8px",
    padding: "0px 3px",
  },
}));

const PanelActions = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "2px",
  "& .MuiIconButton-root": {
    color: "#858585",
    padding: "2px",
    "&:hover": {
      color: "#4fc1ff",
    },
  },
}));

const PanelContent = styled(Box, {
  shouldForwardProp: (prop) => prop !== "panelHeight" && prop !== "minHeight",
})<{ panelHeight?: number | string; minHeight?: number }>(
  ({ panelHeight, minHeight }) => ({
    padding: "4px 8px",
    ...(panelHeight && {
      height:
        typeof panelHeight === "number" ? `${panelHeight}px` : panelHeight,
      overflow: "hidden",
    }),
    ...(minHeight && { minHeight: `${minHeight}px` }),
  })
);

const ExpandIcon = styled(IconButton)(() => ({
  color: "#858585",
  padding: "1px",
  "& .MuiSvgIcon-root": {
    fontSize: "14px",
    "@media (max-height: 800px)": {
      fontSize: "12px",
    },
  },
  "&:hover": {
    color: "#4fc1ff",
  },
}));

export default function SidebarPanel({
  title,
  icon: Icon,
  badge,
  actions = [],
  defaultExpanded = true,
  expanded: controlledExpanded,
  onExpandedChange,
  height,
  minHeight,
  children,
}: SidebarPanelProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

  // Use controlled or uncontrolled mode
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  // Sync internal state with controlled value when switching to controlled mode
  useEffect(() => {
    if (controlledExpanded !== undefined) {
      setInternalExpanded(controlledExpanded);
    }
  }, [controlledExpanded]);

  const handleToggleExpanded = () => {
    const newExpanded = !expanded;
    console.log(
      `SidebarPanel: Toggling ${title} panel from ${expanded} to ${newExpanded}`
    );
    if (isControlled && onExpandedChange) {
      onExpandedChange(newExpanded);
    } else {
      setInternalExpanded(newExpanded);
    }
  };

  return (
    <PanelContainer>
      <PanelHeader onClick={handleToggleExpanded}>
        {Icon && (
          <PanelIcon>
            <Icon />
          </PanelIcon>
        )}
        <PanelTitle>{title}</PanelTitle>
        {badge && <PanelBadge>{badge}</PanelBadge>}
        <PanelActions>
          {actions.map((action, index) => (
            <Tooltip key={index} title={action.tooltip} placement="top">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick();
                }}
              >
                {action.icon}
              </IconButton>
            </Tooltip>
          ))}
        </PanelActions>
        <ExpandIcon>
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </ExpandIcon>
      </PanelHeader>
      <Collapse in={expanded}>
        <PanelContent panelHeight={height} minHeight={minHeight}>
          {children}
        </PanelContent>
      </Collapse>
    </PanelContainer>
  );
}
