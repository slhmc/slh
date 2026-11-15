import { StrictMode } from "react";
import { AnimateUIProvider } from "@animate-ui/react/provider";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AnimateUIProvider><App /></AnimateUIProvider>
  </StrictMode>,
);

