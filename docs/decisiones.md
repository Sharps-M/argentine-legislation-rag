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
**Configuración**: `hnsw.ef_search = 100`, elegido midiendo. Con el valor por
defecto de pgvector (40) el índice perdía respuestas que la búsqueda exacta
encontraba; con 100 devuelve lo mismo que la exacta en 5 ms en lugar de 133. El
detalle está en `docs/evaluacion.md`.
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

## 27. Búsqueda por número de norma, además de por significado

**Decisión**: si la pregunta cita una norma ("Ley 27.818", "Decreto N°
833/2026", "DNU 70/23"), se la busca por tipo, número y año con una consulta
exacta, y sus fragmentos van primeros. El resto de los resultados sale de la
búsqueda por similitud. Cada resultado indica por qué apareció (`reference` o
`semantic`).
**Motivo**: es una herramienta de consulta legal. Quien cita una norma por su
número espera esa norma, siempre, y no "la más parecida". La búsqueda semántica
sola lo resolvía en las mediciones, pero dependía del modelo y de la
configuración del índice; una consulta exacta es determinista y se puede
garantizar con un test.
**Reglas**:

- Hace falta la palabra del tipo ("decreto 833/2026"). Un "12/2025" suelto puede
  ser un mes, y adivinar mal pondría primera una norma que no tiene nada que
  ver.
- Las leyes no llevan año: se numeran una sola vez. Los decretos sí; sin año,
  se toman los más recientes con ese número.
- La norma citada ocupa como máximo la mitad de los resultados: el resto queda
  para lo que la pregunta pide ("¿qué dice el Decreto 833/2026 sobre los
  residentes?" puede necesitar otra norma).
- Los filtros de tipo y año se aplican también a la norma citada.

## 28. Piso de similitud: la búsqueda puede responder "no hay nada"

**Decisión**: un fragmento encontrado por significado se devuelve solo si su
similitud con la pregunta alcanza un mínimo (`minSimilarity`, por defecto
0,55). Si ninguno lo alcanza, el resultado es una lista vacía y el comando lo
dice, con la similitud del fragmento más cercano. Las normas citadas por número
no pasan por el piso: fueron pedidas por su nombre.
**Motivo**: una búsqueda por similitud siempre tiene un "más cercano", por lejos
que esté. Ante "normativas relacionadas con mascotas", sin normas sobre el tema
en el corpus, devolvía decretos sobre zoonosis y ganado con similitudes de 0,52
a 0,56. Para una herramienta legal, mostrar normas que no tienen relación es
peor que decir que no se encontró nada.
**Medición**: con 0,55 se conservan todas las respuestas correctas de la
evaluación y se rechazan las cinco preguntas sin respuesta. El margen es
angosto: el fragmento correcto más bajo tuvo 0,566 y la pregunta sin respuesta
más alta, 0,533.
**El valor ya se movió una vez**: con el corpus inicial era 0,57. Al quintuplicar
los fragmentos, una respuesta correcta quedó en 0,566 y el piso la cortaba. No
es una constante del modelo: depende de qué hay en el corpus.
**Cómo se elige el valor**: la evaluación incluye preguntas sobre temas que el
corpus no cubre, que deben volver vacías. `npm run eval -- --floors` muestra,
para varios pisos, cuántas respuestas correctas se conservan y cuántas de esas
preguntas se rechazan. El piso se aplica después de la consulta, sobre los
resultados, para poder comparar varios valores con una sola corrida.
**Limitación**: la similitud coseno no es una medida calibrada de relevancia. Un
piso fijo separa los casos claros; para los dudosos hace falta un segundo
juicio, que es el del modelo de lenguaje en la etapa 5.

## 29. El corpus suma todas las leyes, sin límite de fecha

**Decisión**: al recorte inicial (leyes y decretos de los últimos cinco años,
decisión 11) se le agregan **todas las leyes y decretos-ley** del dataset,
desde 1853. Los decretos anteriores y las resoluciones siguen afuera.
**Motivo**: "reciente" no es lo mismo que "vigente". Una búsqueda sobre mascotas
no encontraba nada porque lo que regula el tema es anterior al recorte: la ley
de maltrato animal es de 1954 y la que prohíbe las carreras de perros, de 2016.
Una herramienta de consulta legal tiene que encontrar la ley que rige, tenga la
fecha que tenga.
**Cómo se eligió el alcance**: midiendo el dataset antes de decidir.

| Recorte                                         | Normas  | Con texto para descargar | Descarga a 1 pedido/s |
| ----------------------------------------------- | ------- | ------------------------ | --------------------- |
| Inicial: leyes y decretos de cinco años         | 5.069   | 2.986                    | hecha                 |
| **Elegido: más todas las leyes y decretos-ley** | 34.973  | 11.515                   | 2 h 20 min más        |
| Más todos los decretos                          | 105.982 | 32.383                   | 8 h más               |
| Más las resoluciones                            | 328.560 | 142.597                  | 39 h más              |

El dataset tiene 27.613 leyes (8.108 con texto publicado) y 2.462 decretos-ley
(592 con texto). Las que no tienen texto se indexan por su resumen (decisión
17). Con las resoluciones, el índice de vectores no entra en la memoria del
equipo de desarrollo.
**Costo que se acepta**: el Decreto 1088/2011, que regula la castración de
perros y gatos, sigue afuera, igual que cualquier decreto anterior a 2021. Y el
dataset no indica qué normas fueron derogadas: "todas las leyes" incluye leyes
que ya no rigen.
**Resultado**: 34.973 normas cargadas, 8.529 páginas descargadas sin fallos y
170.684 fragmentos nuevos; había estimado 110.000, porque las leyes son más
largas que el promedio anterior. Los vectores se generaron en 84 minutos, a 34
fragmentos por segundo. La búsqueda con índice tarda 7 ms; la exacta pasó de 133
a 682 ms. `ef_search` 100 siguió igualando a la búsqueda exacta; el piso de
similitud hubo que bajarlo (decisión 28).
**Tamaño final**: 211.770 fragmentos, todos con vector. La tabla ocupa 2.953 MB
y el índice HNSW, 1.652 MB: entra en la memoria de un equipo de 16 GB, que es la
condición para que la búsqueda tarde milisegundos.

## 30. Un dato defectuoso no detiene una corrida larga

**Decisión**: tres cambios en las canalizaciones de texto y de embeddings.

- Al extraer el texto se quitan los caracteres de control y las filas de relleno
  ("......", "______") se reducen a tres caracteres.
- Si la base rechaza el texto de una norma, se cuenta como fallo y la corrida
  sigue con la siguiente.
- Si el modelo falla con un lote de fragmentos, se reintenta de a uno. El que no
  se puede vectorizar queda pendiente y se informa al final; si fallan cinco
  seguidos, el problema es el modelo y la corrida se detiene.

**Motivo**: al ampliar el corpus aparecieron páginas que los datos de prueba no
tenían. La de la Ley 24.089 trae bytes sueltos, entre ellos 21 nulos, que
PostgreSQL no acepta en una columna de texto. Es la última página que quedó en
la caché: la descarga se cortó ahí, con 372 páginas de 8.529. Y la generación de vectores se cortó por un único error del
servidor de modelos. En las dos, un caso entre miles tiraba abajo un proceso de
horas.
**Lo que no se hace**: tragarse el error. Cada norma o fragmento apartado queda
en el informe final con su motivo, y un test reproduce la página con bytes
nulos contra PostgreSQL real.

## 31. Versiones de una misma disposición: la más reciente primero

**Estado**: **encendida**, agrupando por cadena con umbral 0,95. Se eligió en
dos mediciones; la primera mostró dos límites que obligaron a medir de otra
manera (más abajo).
**Problema**: hay disposiciones que se reeditan cada pocos meses. Cada decreto
de recomposición salarial repite el artículo del adicional antártico con otros
montos. Para el modelo son casi el mismo texto, así que la búsqueda los
devuelve todos juntos, separados por milésimas, y puede poner primero el del año
pasado: el vigente quedó en el puesto 14.
**Decisión**: dos fragmentos se consideran versiones de una misma disposición
cuando sus textos son casi idénticos (similitud coseno entre sus vectores por
encima de un umbral), pertenecen a normas distintas y esas normas se dictaron en
días distintos. De cada grupo se muestra primero la más reciente y las demás
quedan listadas debajo, con su fecha y su enlace (`earlierVersions`).
**Por qué no ordenar todo por fecha**: porque la fecha no dice nada sobre la
relevancia. Lo más reciente solo desempata entre textos que dicen lo mismo.
**Por qué no ocultar las anteriores**: porque el dataset no informa qué norma
derogó a cuál. "Más reciente" es un dato; "vigente" sería una conclusión que no
puedo respaldar. Además, quien consulta puede necesitar la versión de una fecha
determinada.
**Por qué días distintos**: dos decretos firmados el mismo día que comparten un
párrafo no son una versión vieja y una nueva, son hermanos. Apareció al
probarlo: el Decreto 832/2026 quedaba escondido debajo del 833/2026.
**Cómo se calcula**: la búsqueda trae los 100 fragmentos más cercanos en lugar
de 8, descarta los que no llegan al piso de similitud y compara entre sí los
vectores de los que quedan. No hay columnas ni índices nuevos, y se puede
apagar por consulta (`versions=off`).
**Lo que mostró la primera medición** (detalle en `docs/evaluacion.md`):

- Con umbral 0,95 el recall@5 pasa de 86 % a 95 %. Hasta ahí, lo esperado.
- Comparar cada fragmento solo con el mejor de su grupo parte una misma serie en
  varios grupos, y uno de ellos puede quedar encabezado por una edición vieja.
  Se agregó una segunda forma de agrupar, por cadena (`chain`), para comparar.
- La similitud no distingue una reedición que reemplaza a la anterior de un acto
  nuevo de la misma serie, ni de dos normas distintas que comparten el
  encabezado. Un par de este último tipo dio 0,972, más que casi todas las
  reediciones verdaderas.

**Consecuencia para el diseño**: el agrupamiento se presenta como "normas
anteriores con un texto casi idéntico", nunca como "versión derogada". Y se mide
de los dos lados: lo que gana quien busca la última edición y lo que pierde
quien busca una anterior, con preguntas escritas para eso (tipo `earlier`).
**Lo que decidió la segunda medición**:

| Agrupamiento      | R@1  | R@5  | MRR   | Preguntas por una edición anterior, R@5 |
| ----------------- | ---- | ---- | ----- | --------------------------------------- |
| Apagado           | 64 % | 86 % | 0,749 | 67 %                                    |
| `best`, 0,95      | 73 % | 95 % | 0,826 | 33 %                                    |
| `best`, 0,92      | 82 % | 95 % | 0,890 | 33 %                                    |
| **`chain`, 0,95** | 82 % | 95 % | 0,883 | 67 %                                    |

Agrupar por cadena es la única forma que llega a esa mejora sin empeorar el
otro lado.
Con 0,94 da casi lo mismo; se eligió 0,95 porque es el umbral cuyos grupos se
revisaron uno por uno.
**Costo que se acepta**: la búsqueda pasa de 9 a 28 ms. Y una de las tres
preguntas por una edición anterior baja del puesto 2 al 4: su artículo queda
listado debajo de la edición más reciente, en el primer resultado.
**Límite que queda**: el modelo casi no distingue fechas, así que elegir entre
dos ediciones por su fecha es trabajo para la etapa 5.

## 32. Orden fijo entre fragmentos con la misma similitud

**Decisión**: cuando dos fragmentos tienen exactamente la misma similitud, se
ordenan por su identificador. El desempate se hace en la aplicación, sobre las
filas que ya devolvió la base.
**Motivo**: PostgreSQL no promete ningún orden entre filas empatadas, y el
índice y la búsqueda exacta los devolvían en órdenes distintos. Lo delató un
test que compara las dos búsquedas: fallaba solo después de una carga grande,
cuando cambiaba la disposición física de la tabla. La misma pregunta tiene que
dar siempre la misma lista.
**Por qué no en la consulta**: agregar el identificador al `ORDER BY` le impide
a PostgreSQL usar el índice de vectores para ordenar, y la búsqueda pasaría de
milisegundos a recorrer toda la tabla.

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
