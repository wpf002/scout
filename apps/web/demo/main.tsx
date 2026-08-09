/**
 * The demo entry point.
 *
 * Renders the real page components against the in-browser backend. The chrome
 * below mirrors `app/layout.tsx` rather than importing it, because the layout
 * is a server component that pulls in `next` metadata types the bundle has no
 * use for; everything under it is the genuine article.
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { installDemoBackend } from "./backend.js";
import { navigate, usePath } from "./router.js";
import Dashboard from "@/app/page";
import CasesPage from "@/app/cases/page";
import CaseWorkspace from "@/app/cases/[id]/page";
import SourcesPage from "@/app/sources/page";
import "@/app/globals.css";

installDemoBackend();

function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePath();
  const go = (href: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    navigate(href);
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" onClick={go("/")}>
            SCOUT<span>launcher, not aggregator</span>
          </a>
          <nav className="nav">
            <a href="#/" onClick={go("/")}>Watch floor</a>
            <a href="#/cases" onClick={go("/cases")}>Cases</a>
            <a href="#/sources" onClick={go("/sources")}>Sources</a>
            <span className="badge accent" title="Everything runs in this page">
              demo
            </span>
          </nav>
        </div>
      </header>
      <main className="shell" key={path}>
        {children}
      </main>
    </>
  );
}

function App() {
  const path = usePath();

  useEffect(() => {
    if (window.location.hash === "") navigate("/");
  }, []);

  const page =
    path === "/" ? <Dashboard />
    : path === "/cases" ? <CasesPage />
    : path === "/sources" ? <SourcesPage />
    : /^\/cases\/[^/]+$/.test(path) ? <CaseWorkspace />
    : <Dashboard />;

  return <Chrome>{page}</Chrome>;
}

const mount = document.getElementById("root");
if (mount !== null) {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
