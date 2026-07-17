# PDF Compressor

Compresor de documentos PDF escaneados que funciona completamente en el navegador. No usa backend, no sube archivos y puede publicarse como un sitio estático en GitHub Pages.

**Sitio:** <https://ache1312.github.io/pdf_compressor/>

## Qué hace

- Lee el PDF mediante la API local de archivos del navegador.
- Renderiza una página a la vez para limitar el uso de memoria.
- Reconstruye el documento con imágenes JPEG y conserva las dimensiones de cada página.
- Reduce resolución y calidad progresivamente hasta cumplir el límite solicitado.
- Comprueba el tamaño exacto en MB decimales y valida el número de páginas antes de habilitar la descarga.
- Sirve PDF.js, su worker, fuentes, CMaps y WASM desde el mismo repositorio: no depende de CDN en tiempo de ejecución.

El perfil recomendado parte en 150 ppp y JPEG 40. En la prueba de aceptación, un PDF escaneado de 113 páginas y 101,47 MB quedó en 17,18 MB conservando las 113 páginas.

## Privacidad

El documento permanece en la memoria del dispositivo. No hay formularios de carga, analítica ni solicitudes a servicios externos. La política de seguridad del contenido limita las conexiones al mismo origen.

## Límites conocidos

La compresión rasteriza las páginas. Es adecuada para escaneos, pero aplana o elimina:

- OCR y texto seleccionable;
- enlaces y formularios interactivos;
- capas, adjuntos y comentarios editables;
- validez criptográfica de firmas digitales.

Para documentos que ya pesan menos que el objetivo, la aplicación entrega el original sin alterarlo.

## Desarrollo local

Requiere Node.js 22.13 o superior para actualizar las dependencias vendorizadas.

```bash
npm install
npm run vendor
npm run serve
```

Abre <http://localhost:4173/>.

`npm run vendor` copia versiones fijadas de PDF.js y pdf-lib desde `node_modules/` hacia `vendor/`. Los archivos de `vendor/` se incluyen en Git para que GitHub Pages pueda servir la aplicación sin un paso de compilación.

## Publicación en GitHub Pages

1. Publica el contenido en la rama `main`.
2. En **Settings → Pages**, selecciona **Deploy from a branch**.
3. Elige la rama `main` y la carpeta `/ (root)`.

Todas las rutas son relativas y funcionan bajo la subruta `/pdf_compressor/`.

## Dependencias

- [PDF.js](https://mozilla.github.io/pdf.js/) 6.1.200 — Apache-2.0.
- [pdf-lib](https://pdf-lib.js.org/) 1.17.1 — MIT.

Los avisos y licencias vendorizados están en [`vendor/`](./vendor/).

## Licencia

MIT. Consulta [`LICENSE`](./LICENSE).
