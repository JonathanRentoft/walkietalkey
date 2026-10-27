/* Værkstedet: the training workbench's page (wt-train studio). Light theme only; everything it
   loads comes from this server (fonts and tokens from the design system, bundled). */
import "@walkietalkey/ui/fonts.css";
import "@walkietalkey/ui/tokens.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
