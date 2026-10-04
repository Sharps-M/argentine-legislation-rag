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

## 14. Descarga respetuosa del sitio de InfoLEG

**Decisión**: el texto de cada norma se baja con un cliente que se identifica
(`User-Agent` con el nombre del proyecto y la URL del repositorio), hace un
pedido por vez, espera un segundo entre pedidos y reintenta con espera creciente
solo ante errores del servidor. Un 403 o un 404 no se reintenta, y tras cinco
403 seguidos el comando se detiene.
**Motivo**: es un servidor público que no publica reglas para programas. Lo
correcto es decir quién pregunta, pedir despacio y parar si responde que no. El
cliente por defecto de `curl` recibe 403; uno que se identifica, no.

## 15. Páginas descargadas en caché local

**Decisión**: cada página se guarda tal como llegó en `data/infoleg/html/`
(fuera del repositorio). Volver a dividir en fragmentos lee de ahí.
**Motivo**: la descarga es la parte lenta y la que usa un servidor ajeno. Con la
caché, cambiar el algoritmo de división no vuelve a pedir nada, y un corte a
mitad de camino se retoma donde quedó.

## 16. Fragmentos según la estructura legal, no por tamaño fijo

**Decisión**: una norma se divide en encabezado (título, VISTO, CONSIDERANDO),
**un fragmento por artículo**, cierre (firmas, línea de publicación, notas de
InfoLEG) y anexos. Solo las partes que superan el máximo (1.800 caracteres) se
subdividen, por párrafo, y conservan su sección y su etiqueta.
**Motivo**: el artículo es la unidad con sentido propio y la que se cita. Cortar
cada N caracteres parte artículos por la mitad y mezcla el final de uno con el
principio del siguiente. Los artículos citados entre comillas dentro de otro
artículo no generan un corte, y los artículos de un tratado anexo se etiquetan
como anexo para no confundirlos con los de la ley que lo aprueba.

## 17. Las normas sin texto publicado se indexan por su resumen

**Decisión**: cuando InfoLEG no publica el texto de una norma (cerca del 43% de
los decretos del recorte), se genera un único fragmento con su tema, tipo y
número, título y resumen.
**Motivo**: siguen siendo normas vigentes que alguien puede buscar. Un resumen
buscable es mejor que una norma invisible; el origen queda marcado (`summary`)
para que la interfaz pueda avisarlo.

## 18. Se prefiere el texto actualizado

**Decisión**: si una norma tiene texto actualizado (consolidado con sus
modificaciones), se usa ese; si no, el original.
**Motivo**: quien pregunta qué dice una norma quiere saber qué dice hoy.

## 19. Limitación conocida: anexos publicados como imagen

Muchos anexos (tablas salariales, organigramas) están en InfoLEG como imágenes.
De esos anexos solo queda el título; su contenido no se puede buscar. Leerlos
requeriría OCR, que queda fuera del alcance.

## 20. El proveedor de IA queda detrás de una interfaz propia

**Decisión**: el resto del código depende de un tipo `Embedder` (modelo,
dimensiones y una función que convierte textos en vectores), no de una
biblioteca. La implementación actual usa el AI SDK contra el endpoint compatible
con OpenAI de Ollama (`/v1/embeddings`).
**Motivo**: cambiar de proveedor es escribir otra implementación de quince
líneas, sin tocar la ingesta ni la búsqueda. Y los tests usan un `Embedder`
determinista, sin modelo ni red.

## 21. Embeddings locales con bge-m3

**Decisión**: los vectores se generan en el equipo con `bge-m3` servido por
Ollama: multilingüe, 1.024 dimensiones, licencia abierta.
**Motivo**: es gratuito, entra en una placa de 6 GB y el texto de las normas no
sale del equipo. Al ser multilingüe, una pregunta en inglés encuentra una norma
en español sin traducir nada. Un servicio externo con nivel gratuito impondría
límites de uso para vectorizar decenas de miles de fragmentos y ataría el índice
a ese proveedor.

## 22. Cada vector guarda el modelo que lo generó

**Decisión**: `chunks` tiene la columna `embedding` y, al lado,
`embedding_model`. Un fragmento está pendiente si no tiene vector o si el que
tiene es de otro modelo, y la búsqueda solo compara vectores del modelo en uso.
**Motivo**: los vectores de dos modelos viven en espacios distintos; compararlos
da números sin sentido y sin ningún error que lo delate. Con el modelo guardado,
cambiar `EMBEDDING_MODEL` hace que `npm run embed` rehaga lo necesario. Lo que sí
exige una migración es cambiar de tamaño de vector, porque es parte del tipo de
la columna; por eso el comando verifica las dimensiones antes de guardar.

## 23. Se vectoriza el fragmento con el contexto de su norma

**Decisión**: el texto que se envía al modelo es
`norma · tema · título · artículo` seguido del contenido del fragmento. En la
base se guarda el contenido sin ese encabezado.
**Motivo**: un artículo suelto ("Comuníquese al Poder Ejecutivo nacional") no
dice a qué norma pertenece. Con el encabezado, una pregunta que nombra la norma
o su tema cae en los fragmentos correctos.

## 24. Índice HNSW con distancia coseno y filtros en la misma consulta

**Decisión**: índice HNSW de pgvector sobre `embedding` con `vector_cosine_ops`.
La búsqueda ordena por distancia coseno y aplica los filtros (tipo de norma,
años) en el mismo `SELECT`, con _iterative scan_ activado (pgvector 0.8 o
superior).
**Motivo**: HNSW no necesita entrenarse con los datos y responde en milisegundos
a este volumen. Un índice aproximado devuelve primero sus candidatos más
cercanos y recién después se aplican los filtros: con un filtro muy selectivo
(solo leyes, que son una fracción mínima de los fragmentos) podían quedar menos
resultados que los pedidos, o ninguno. El _iterative scan_ sigue recorriendo el
índice hasta completar el límite. Un test de integración reproduce ese caso.
**A tener en cuenta**: las filas borradas o reemplazadas siguen en el índice
hasta que PostgreSQL las limpia (`VACUUM`), y mientras tanto la búsqueda las
recorre sin poder devolverlas. Con decenas de miles acumuladas, medí búsquedas
que devolvían menos resultados de los que había. Por eso `npm run embed` termina
con un `VACUUM (ANALYZE)` de la tabla.

## 25. La recuperación se mide con preguntas de respuesta conocida

**Decisión**: `npm run eval` corre un conjunto de preguntas escritas leyendo la
norma a la que apuntan y calcula _recall@k_ y MRR, en total y por tipo de
pregunta (tema, referencia por número, inglés). Se mide a nivel de fragmento: en
qué posición aparece el primer fragmento de la norma esperada.
**Motivo**: sin una medida, cambiar el tamaño de los fragmentos o el modelo es
adivinar. Separar por tipo muestra dónde falla la búsqueda semántica (por
ejemplo, al pedir una norma por su número) y orienta qué mejorar.
**Limitación**: son pocas preguntas sobre nueve normas. Sirve para detectar
regresiones y comparar variantes, no como medida absoluta de calidad.

## 26. Una sola validación para el endpoint y la línea de comandos

**Decisión**: `GET /api/search` y `npm run search` validan los parámetros con el
mismo esquema Zod. El endpoint responde 400 con la lista de problemas, 503 si no
se puede consultar el modelo de embeddings y 200 con los resultados (una lista
vacía es una respuesta válida).
**Motivo**: las reglas (largo de la pregunta, límite máximo, rango de años)
existen en un solo lugar. Distinguir el 503 del 500 le dice a quien llama que el
problema es un servicio caído y no un error del programa.

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
