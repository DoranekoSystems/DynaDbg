import { useState, useEffect, useCallback } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { MainApp } from "./components/MainApp";
import { WatchpointExceptionPage } from "./pages/WatchpointExceptionPage";
import { CodeTracingPage } from "./pages/CodeTracingPage";
import { GraphViewPage } from "./pages/GraphViewPage";
import { TerminalPage } from "./pages/TerminalPage";
import { LicenseAgreementDialog } from "./components/LicenseAgreementDialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const LICENSE_AGREED_KEY = "dynadbg_license_agreed";

// Main Application Component with Routing
function TauriDebugger() {
  const location = useLocation();
  const [showLicenseDialog, setShowLicenseDialog] = useState(false);
  const [licenseAgreed, setLicenseAgreed] = useState(false);

  console.log("TauriDebugger component rendered");
  console.log("Current location:", window.location);
  console.log("React Router location:", location);
  console.log("pathname:", location.pathname);
  console.log("hash:", location.hash);

  // Check if this is a child window (Code Tracing, Watchpoint, Graph View)
  // Child windows are opened from already-authenticated main window, so skip auth checks
  const isChildWindow = location.pathname !== "/" && location.pathname !== "";

  // Check license on mount (skip for child windows)
  useEffect(() => {
    // Skip license check for child windows - they inherit from main window
    if (isChildWindow) {
      setLicenseAgreed(true);
      return;
    }

    const licenseAgreed = localStorage.getItem(LICENSE_AGREED_KEY);
    if (licenseAgreed === "true") {
      setLicenseAgreed(true);
    } else {
      setShowLicenseDialog(true);
    }
  }, [isChildWindow]);

  const handleLicenseAgree = useCallback(() => {
    localStorage.setItem(LICENSE_AGREED_KEY, "true");
    setShowLicenseDialog(false);
    setLicenseAgreed(true);
  }, []);

  const handleLicenseDisagree = useCallback(async () => {
    // Close the application
    const window = getCurrentWebviewWindow();
    await window.close();
  }, []);

  // Show license dialog if not agreed
  if (!licenseAgreed) {
    return (
      <LicenseAgreementDialog
        open={showLicenseDialog}
        onAgree={handleLicenseAgree}
        onDisagree={handleLicenseDisagree}
      />
    );
  }

  return (
    <Routes>
      <Route path="/" element={<MainApp />} />
      <Route
        path="/watchpoint-exception/:watchpointId"
        element={<WatchpointExceptionPage />}
      />
      <Route path="/code-tracing" element={<CodeTracingPage />} />
      <Route path="/graph-view" element={<GraphViewPage />} />
      <Route path="/terminal" element={<TerminalPage />} />
    </Routes>
  );
}

export default TauriDebugger;
