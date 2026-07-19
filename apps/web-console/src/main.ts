import { resolveLegacyRedirect } from "./redirects.js";
import "./styles.css";

const target = resolveLegacyRedirect(window.location.pathname, window.location.search, {
  nova: import.meta.env.VITE_NOVA_CONSOLE_URL ?? "http://localhost:3010",
  lumen: import.meta.env.VITE_LUMEN_CONSOLE_URL ?? "http://localhost:3002",
  pulso: import.meta.env.VITE_PULSO_CONSOLE_URL ?? "http://localhost:3000"
});

const root = document.getElementById("root")!;
const section = document.createElement("section");
const heading = document.createElement("h1");
const description = document.createElement("p");
section.append(heading, description);
root.append(section);
if (target) {
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Hyperion";
  heading.before(eyebrow);
  heading.textContent = "Redirigiendo…";
  description.textContent = "Esta aplicación ahora tiene un origen independiente.";
  const link = document.createElement("a");
  link.href = target;
  link.textContent = "Continuar";
  section.append(link);
  window.location.replace(target);
} else {
  document.title = "404 · Hyperion";
  const code = document.createElement("p");
  code.className = "code";
  code.textContent = "404";
  heading.before(code);
  heading.textContent = "Ruta inexistente";
  description.textContent = "La consola compartida fue retirada. Verifica el enlace de producto.";
}
