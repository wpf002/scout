/**
 * The demo entry point.
 *
 * Renders the real page against the in-browser backend, so the single-file
 * build shows the genuine surface rather than a mock of it. There is one page
 * now, so there is no router here either.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installDemoBackend } from "./backend.js";
import Dashboard from "@/app/page";
import "@/app/globals.css";

installDemoBackend();

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Dashboard />
    </StrictMode>,
  );
}
