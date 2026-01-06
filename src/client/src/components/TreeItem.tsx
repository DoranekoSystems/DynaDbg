import React, { useState } from "react";
import {
  Box,
  Typography,
  Chip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  styled,
  alpha,
} from "@mui/material";
import { FiberManualRecord as FiberManualRecordIcon } from "@mui/icons-material";

interface ChipData {
  label: string;
  color?:
    | "default"
    | "primary"
    | "secondary"
    | "error"
    | "info"
    | "success"
    | "warning";
  variant?: "filled" | "outlined";
}

interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  divider?: boolean;
}

interface TreeItemProps {
  children: React.ReactNode;
  details?: string;
  icon?: React.ComponentType;
  color?: string;
  active?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
  chips?: ChipData[];
  contextMenu?: ContextMenuItem[];
}

const TreeItemContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "active" && prop !== "highlighted",
})<{ active?: boolean; highlighted?: boolean }>(({ active, highlighted }) => ({
  position: "relative",
  padding: "4px 10px 4px 24px",
  display: "flex",
  alignItems: "center",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "pointer",
  backgroundColor: active
    ? alpha("#4fc1ff", 0.15)
    : highlighted
      ? alpha("#3c3c3c", 0.5)
      : "transparent",
  color: active ? "#4fc1ff" : "#d4d4d4",
  borderLeft: `2px solid ${active ? "#4fc1ff" : "transparent"}`,
  "&:hover": {
    backgroundColor: active ? alpha("#4fc1ff", 0.2) : "#3c3c3c",
  },
  transition:
    "background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease",
}));

const TreeItemIconContainer = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  position: "absolute",
  left: "4px",
  top: "50%",
  transform: "translateY(-50%)",
  width: "16px",
  height: "16px",
}));

const TreeItemContent = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  width: "100%",
}));

const TreeItemText = styled(Typography)(() => ({
  fontSize: "12px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  flexGrow: 1,
}));

const TreeItemDetails = styled(Typography)(() => ({
  fontSize: "11px",
  color: "#858585",
  marginLeft: "8px",
  whiteSpace: "nowrap",
}));

const TreeItemChip = styled(Chip)(() => ({
  height: "16px",
  fontSize: "10px",
  marginLeft: "4px",
}));

export default function TreeItem({
  children,
  details,
  icon,
  color,
  active,
  highlighted,
  onClick,
  chips = [],
  contextMenu,
}: TreeItemProps) {
  const IconComponent = icon || FiberManualRecordIcon;

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (contextMenu) {
      event.preventDefault();
      setAnchorEl(event.currentTarget);
    }
  };

  const handleCloseMenu = () => {
    setAnchorEl(null);
  };

  const handleMenuAction = (action: ContextMenuItem) => {
    handleCloseMenu();
    action.onClick && action.onClick();
  };

  return (
    <>
      <TreeItemContainer
        active={active}
        highlighted={highlighted}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        <TreeItemIconContainer>
          <IconComponent
            fontSize="inherit"
            sx={{
              color: color || (active ? "#4fc1ff" : "#858585"),
              fontSize: "14px",
            }}
          />
        </TreeItemIconContainer>
        <TreeItemContent>
          <TreeItemText>{children}</TreeItemText>
          {details && <TreeItemDetails>{details}</TreeItemDetails>}
          {chips.map((chip, index) => (
            <TreeItemChip
              key={index}
              label={chip.label}
              size="small"
              color={chip.color || "default"}
              variant={chip.variant || "outlined"}
            />
          ))}
        </TreeItemContent>
      </TreeItemContainer>

      {contextMenu && (
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleCloseMenu}
          MenuListProps={{
            dense: true,
          }}
          PaperProps={{
            sx: {
              backgroundColor: "#2d2d30",
              border: "1px solid",
              borderColor: "#464647",
              boxShadow: 4,
            },
          }}
        >
          {contextMenu.map((item, index) => (
            <MenuItem
              key={index}
              onClick={() => handleMenuAction(item)}
              disabled={item.disabled}
              divider={item.divider}
              sx={{ fontSize: 12 }}
            >
              {item.label && (
                <>
                  {item.icon && (
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      {item.icon}
                    </ListItemIcon>
                  )}
                  <ListItemText primary={item.label} />
                </>
              )}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
