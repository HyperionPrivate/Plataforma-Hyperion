# Política de seguridad

## Versiones soportadas

Hyperion está en transición hacia repositorios federados. Se corrigen vulnerabilidades únicamente en la rama `main` y en la última versión desplegada de cada componente. Las ramas de demostración, experimentales o históricas no reciben parches de seguridad.

| Versión                                  | Soporte |
| ---------------------------------------- | ------- |
| `main`                                   | Sí      |
| Último release desplegado por componente | Sí      |
| Releases anteriores y ramas alternativas | No      |

## Reportar una vulnerabilidad

No abras un issue público ni publiques pruebas de concepto que contengan datos, secretos o instrucciones de explotación.

Usa, en este orden:

1. El formulario privado de GitHub: `https://github.com/HyperionPrivate/Plataforma-Hyperion/security/advisories/new`.
2. Si el formulario no está disponible, escribe a `administracionhyperion@gmail.com` con el asunto `SECURITY - Hyperion`.

Incluye el componente y versión afectados, impacto, condiciones necesarias, pasos mínimos de reproducción y una forma segura de contacto. Elimina o anonimiza datos personales y credenciales.

Confirmaremos recepción en un máximo de 2 días hábiles y comunicaremos una evaluación inicial en 5 días hábiles. La fecha de corrección y divulgación se coordinará según severidad, explotabilidad y riesgo operativo. Si el reporte no es reproducible o queda fuera de alcance, explicaremos el motivo.

## Alcance y puerto seguro

Son elegibles los servicios, consolas, contratos, imágenes y automatizaciones mantenidos en este repositorio. Quedan fuera de alcance la ingeniería social, ataques de denegación de servicio, pruebas sobre datos reales, proveedores externos sin autorización y cualquier acción que degrade producción.

La investigación de buena fe está autorizada cuando usa cuentas y datos propios, minimiza el acceso, evita persistencia y exfiltración, se detiene al confirmar el hallazgo y se reporta de forma privada. No se autoriza acceder a tenants ajenos ni conservar datos obtenidos accidentalmente.
