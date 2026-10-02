# Decisiones de arquitectura

Registro de las decisiones de diseño del proyecto y de por qué se eligió cada
opción. Las decisiones no se borran cuando quedan superadas: se marcan como
tales y se anota qué las reemplazó.

## 1. Todo el proyecto en TypeScript, con Next.js

**Decisión**: Next.js 16 (App Router) con TypeScript en modo estricto y
`noUncheckedIndexedAccess`, tanto para la interfaz como para la API y los
comandos de ingesta.
**Motivo**: un solo lenguaje y un solo sistema de tipos de punta a punta. Los
tipos del esquema de la base llegan hasta la interfaz sin duplicarse.

## 2. PostgreSQL con pgvector en lugar de una base vectorial dedicada

**Decisión**: las normas, sus fragmentos y sus vectores viven en la misma base
PostgreSQL, con la extensión pgvector.
**Motivo**: los filtros (tipo de norma, año) y la búsqueda por similitud se
resuelven en una sola consulta SQL, con transacciones y sin sincronizar dos
almacenes. Para el volumen de este proyecto no hace falta un servicio aparte.

## 3. Migraciones SQL versionadas con Drizzle

**Decisión**: el esquema se define en TypeScript con Drizzle y los cambios se
aplican con migraciones SQL versionadas en `drizzle/`. La primera solo habilita
la extensión `vector`.
**Motivo**: las migraciones quedan legibles como SQL y se aplican igual en
desarrollo, en CI y en producción (`npm run db:migrate`).

## 4. Variables de entorno validadas con Zod

**Decisión**: `src/env.ts` valida las variables de entorno y falla con un
mensaje que nombra cada variable inválida. La validación es perezosa: ocurre al
primer uso, no al importar el módulo.
**Motivo**: un error de configuración se ve al arrancar, con un mensaje claro,
y no como un fallo confuso más adelante. La validación perezosa permite compilar
la aplicación sin una base de datos disponible.

## 5. Chequeo de salud con una sonda inyectable

**Decisión**: `checkHealth` recibe una sonda (`HealthProbe`) con las dos
consultas que necesita. La aplicación le pasa la sonda real; los tests, una
simulada.
**Motivo**: la lógica (qué significa "degradado") se prueba sin base de datos, y
el test de integración ejercita la sonda real contra PostgreSQL.

## 6. Interfaz bilingüe con rutas por idioma

**Decisión**: todas las páginas cuelgan de `app/[lang]` (`/es`, `/en`). Un
`proxy.ts` redirige las rutas sin prefijo según el encabezado
`Accept-Language`. Los textos viven en diccionarios JSON; el español es el de
referencia y define el tipo `Dictionary`.
**Motivo**: es el patrón que documenta Next.js y no agrega dependencias. Si al
diccionario en inglés le falta una clave, el proyecto no compila.

## 7. Tests unitarios y de integración separados

**Decisión**: `npm test` corre los tests unitarios (sin servicios externos) y
`npm run test:integration` corre los que necesitan PostgreSQL. En CI son dos
trabajos distintos.
**Motivo**: los unitarios dan respuesta en segundos; los de integración
verifican contra la base real lo que un doble no puede garantizar.

## 8. Sin fuentes ni recursos de terceros en tiempo de ejecución

**Decisión**: la interfaz usa la tipografía del sistema, sin fuentes externas.
**Motivo**: la compilación no depende de la red y la aplicación no envía datos
de navegación a terceros.

## 9. Ingesta como flujo validado, con informe

**Decisión**: el CSV de InfoLEG se lee como flujo (`csv-parse`), cada fila se
valida con Zod y las filas inválidas **se informan, no abortan** la carga. El
comando termina con un informe: filas leídas, rechazadas (motivo y línea de las
primeras), fuera del recorte y cargadas, por tipo y por año.
**Motivo**: el archivo completo no entra cómodo en memoria, y un dato oficial
mal cargado en una fila entre cientos de miles no puede frenar todo. El informe
permite medir la calidad real del dataset en lugar de suponerla; `--dry-run` lo
produce sin tocar la base.

## 10. Carga idempotente por identificador de InfoLEG

**Decisión**: la clave primaria de `regulations` es el `id_norma` de InfoLEG y
la carga hace _upsert_. Volver a correr la ingesta actualiza las filas, no las
duplica.
**Motivo**: InfoLEG republica el dataset todos los meses, con normas nuevas y
con cambios en las existentes (por ejemplo, cuántas normas las modifican).

## 11. El recorte se aplica en la ingesta, no en la consulta

**Decisión**: el subconjunto (tipos de norma y fecha mínima) se filtra al
cargar. Por defecto: leyes y decretos de los últimos cinco años.
**Motivo**: generar embeddings cuesta tiempo de cómputo por fragmento. Cargar
solo lo que se va a indexar mantiene la base y el índice acotados; ampliar el
recorte es volver a correr el comando con otros parámetros.

## 12. La canalización no conoce la base de datos

**Decisión**: `ingestRegulations` recibe un flujo de registros y un
`RegulationStore`. El almacén real usa Drizzle; los tests usan uno en memoria.
**Motivo**: las reglas (validar, filtrar, agrupar en lotes, contar) se prueban
sin PostgreSQL. El test de integración verifica aparte el _upsert_ real.

## 13. Se indexan todas las normas del recorte, incluidas las designaciones

**Decisión**: no se excluyen los decretos de designación ni otras normas que
nombran personas. Se cargan tal como los publica InfoLEG.
**Motivo**: es información oficial, pública y con licencia abierta, y forma
parte de lo que un usuario puede querer consultar. La aplicación no agrega datos
personales: solo vuelve buscable lo que ya está publicado.
**A tener en cuenta**: con el nivel gratuito de Gemini, los fragmentos
recuperados se envían a la API de Google, que puede usarlos para mejorar sus
productos. Con un modelo local (Ollama) nada sale del equipo.

---

## Desarrollo asistido por IA

El proyecto se desarrolla con asistencia de IA bajo reglas explícitas, que
también están en `AGENTS.md` para que las lean las herramientas.

- **El código es la fuente de verdad.** Si la documentación y el código no
  coinciden, gana el código y se corrige la documentación.
- **Pasos atómicos y verificados.** Cada etapa termina con algo que se puede
  ejecutar y comprobar antes de pasar a la siguiente.
- **No inventar.** Versiones, comandos y APIs se verifican en `package.json` y
  en la documentación de la dependencia, no de memoria.
- **Sin datos sensibles.** Credenciales y hosts reales viven solo en `.env`.
