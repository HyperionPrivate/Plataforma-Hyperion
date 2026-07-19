import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("No se encontró el contenedor raíz de NOVA");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
