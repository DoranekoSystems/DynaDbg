import React from "react";
import { Box, styled } from "@mui/material";
import TreeItem from "./TreeItem";

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

interface ExpandableTreeItemProps {
  children: React.ReactNode;
  icon?: React.ComponentType;
  color?: string;
  active?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
  chips?: ChipData[];
  expanded?: boolean;
  onToggle?: () => void;
}

const ExpandableContainer = styled(Box)(() => ({
  position: "relative",
}));

export default function ExpandableTreeItem({
  children,
  icon,
  color,
  active,
  highlighted,
  onClick,
  chips = [],
  onToggle,
}: ExpandableTreeItemProps) {
  const handleClick = () => {
    if (onToggle) {
      onToggle();
    }
    if (onClick) {
      onClick();
    }
  };

  return (
    <ExpandableContainer>
      <TreeItem
        icon={icon}
        color={color}
        active={active}
        highlighted={highlighted}
        onClick={handleClick}
        chips={chips}
      >
        {children}
      </TreeItem>
    </ExpandableContainer>
  );
}
