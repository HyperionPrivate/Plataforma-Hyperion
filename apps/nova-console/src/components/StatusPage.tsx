import { ArrowLeft, LockKeyhole, Orbit } from "lucide-react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="status-page" id="main-content">
      <div className="status-card">
        <Orbit size={32} aria-hidden="true" />
        <p className="status-code">404</p>
        <h1>Ruta no encontrada</h1>
        <p>Esta consola solo publica flujos de NOVA.</p>
        <Link className="btn btn-primary" to="/">
          <ArrowLeft size={17} aria-hidden="true" />
          Volver a la operación
        </Link>
      </div>
    </main>
  );
}

export function ForbiddenPage({ onLogout }: { onLogout?: () => void }) {
  return (
    <main className="status-page" id="main-content">
      <div className="status-card">
        <LockKeyhole size={32} aria-hidden="true" />
        <p className="status-code">403</p>
        <h1>Acceso no autorizado</h1>
        <p>Tu sesión no tiene un grant activo de lectura para NOVA.</p>
        {onLogout ? (
          <button className="btn btn-primary" type="button" onClick={onLogout}>
            Cambiar de cuenta
          </button>
        ) : null}
      </div>
    </main>
  );
}
