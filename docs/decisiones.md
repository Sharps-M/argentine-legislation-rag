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
