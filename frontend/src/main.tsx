import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initFrontendLogger, logError } from "./logger";

initFrontendLogger();

if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    logError("window", event.message || "Unhandled window error", {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    logError("window", "Unhandled promise rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
