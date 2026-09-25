# apiaddicts-examples

Repositorio de ejemplos y proyectos **didácticos** utilizados en los cursos de
[apiaddicts](https://www.apiaddicts.org/). El contenido tiene fines exclusivamente
formativos: ilustrar conceptos, patrones y buenas prácticas que se explican
durante las sesiones de formación.

## Proyectos

### AI examples

Ejemplos relacionados con inteligencia artificial y el protocolo MCP (Model
Context Protocol).

- **[mcp-auth-support](AI%20examples/mcp-auth-support/README.md)** — Monorepo
  de ejemplo del curso *MCP Owner: Seguridad y Testing*. Simula un backend de
  soporte al cliente multi-tenant expuesto como servidor MCP, con un
  Authorization Server externo que valida tokens vía introspección OAuth 2.0.
  Sirve para demostrar los controles de seguridad (autenticación,
  autorización, aislamiento de tenants, auditoría) que debe exigir un MCP
  Owner antes de publicar una capacidad a un agente.

### SlideTimer Lite

- **[SlideTimer Lite](SlideTimer%20Lite/slide_pace_timer.html)** — Herramienta
  standalone en HTML/JS (sin dependencias ni build) para controlar el ritmo de
  una presentación por diapositiva: mide tiempo objetivo vs. real, muestra la
  desviación de cada slide y el balance acumulado, y permite exportar los
  resultados a CSV/JSON. Se usa como apoyo durante las sesiones de formación
  para no salirse del tiempo asignado a cada bloque.

## Licencia

Este repositorio se distribuye bajo la licencia MIT. Consulta el fichero
[LICENSE](LICENSE) para más detalles.
