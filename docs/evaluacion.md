# Evaluación de la recuperación

Registro de las mediciones de la búsqueda. Cada una se obtiene con
`npm run eval` sobre el corpus completo (5.069 normas, 41.275 fragmentos) y las
18 preguntas de `src/eval/questions.ts`.

- **recall@k**: en qué proporción de las preguntas aparece un fragmento de la
  norma esperada entre los primeros _k_ resultados.
- **MRR**: promedio de 1/posición del primer acierto; 1 significa "siempre
  primero".

Son pocas preguntas: una sola equivale a 5,6 puntos de recall. Los números
sirven para comparar variantes entre sí, no como medida absoluta.

## Línea de base — 4 de octubre de 2026

Búsqueda solo semántica: `bge-m3`, distancia coseno, índice HNSW, cada fragmento
vectorizado con el contexto de su norma.

| Preguntas           | n   | R@1  | R@3  | R@5  | R@10 | MRR   |
| ------------------- | --- | ---- | ---- | ---- | ---- | ----- |
| Todas               | 18  | 44 % | 67 % | 72 % | 72 % | 0,561 |
| Por tema            | 12  | 42 % | 75 % | 83 % | 83 % | 0,592 |
| Por número de norma | 4   | 50 % | 50 % | 50 % | 50 % | 0,500 |
| En inglés           | 2   | 50 % | 50 % | 50 % | 50 % | 0,500 |

### Qué quedó fuera de los primeros cinco resultados

| Pregunta                                                                                  | Tipo   | Posición |
| ----------------------------------------------------------------------------------------- | ------ | -------- |
| ¿Qué dispone la Ley 27818?                                                                | número | —        |
| Decreto 833/2026                                                                          | número | —        |
| Social security agreement between Argentina and San Marino                                | inglés | —        |
| Tope de la retribución de los agentes habilitados para realizar servicios extraordinarios | tema   | —        |
| Adicional por prestación de servicios en la Antártida para el personal militar            | tema   | 14       |

"—" significa que la norma no apareció entre los primeros 20 fragmentos.

### Primera lectura (antes de mirar los resultados)

Anotada tal como se planteó, porque una de las dos hipótesis resultó falsa.

1. _Pedir una norma por su número es el punto débil: un embedding representa el
   significado de un texto, no sus cifras._ **Falsa**: ver el diagnóstico.
2. _Hay normas que se repiten casi iguales y la búsqueda devuelve una anterior
   equivalente._ **Confirmada.**

## Diagnóstico — 4 de octubre de 2026

Dos corridas más sobre los mismos datos: `--verbose`, que muestra qué se
devolvió en lugar de la norma esperada, y `--exact`, que saltea el índice y
compara la pregunta contra los 41.275 fragmentos.

| Búsqueda                         | R@1  | R@3  | R@5  | R@10 | MRR   |
| -------------------------------- | ---- | ---- | ---- | ---- | ----- |
| Índice HNSW, valores por defecto | 44 % | 67 % | 72 % | 72 % | 0,561 |
| Exacta (sin índice)              | 61 % | 83 % | 89 % | 89 % | 0,728 |

### El índice aproximado perdía tres respuestas

Con la búsqueda exacta, las cuatro preguntas por número y las dos en inglés
quedan **primeras**. El modelo las resuelve bien, ayudado por el encabezado de
contexto de cada fragmento ("Decreto 833/2026 · ACUERDOS · …"). Quien no las
encontraba era el índice HNSW con su configuración por defecto
(`hnsw.ef_search = 40`): para "Decreto 833/2026" devolvía decretos sin relación
con similitud 0,58 a 0,61, cuando el fragmento correcto existía y estaba más
cerca.

Un índice aproximado recorre un grafo y se queda con los mejores candidatos que
encuentra en el camino; no garantiza llegar al vecino más cercano. Las tres
preguntas que perdió son muy cortas o están en otro idioma, es decir, poco
parecidas a cualquier fragmento. Es probable que ese sea el caso en que el
recorrido más se desvía, pero eso todavía no está medido.

Lo que se aprende: **medir el índice contra la búsqueda exacta**. Sin esa
comparación, el error se le atribuía al modelo.

### Normas que se repiten casi iguales

Los dos fallos que quedan con la búsqueda exacta, y casi todas las preguntas que
no salen primeras, son el mismo fenómeno:

| Pregunta                                       | Qué salió primero                                                             | Similitud     |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ------------- |
| Adicional por servicios en la Antártida        | Artículo 5 de los Decretos 294/2025, 578/2025, 113/2025, 553/2026 y 1040/2024 | 0,818 a 0,825 |
| Tope de retribución, servicios extraordinarios | Artículo 3 de los Decretos 112/2025, 1038/2024, 293/2025 y 206/2024           | 0,708 a 0,712 |
| Remuneraciones de residentes del Garrahan      | Artículo 5 del Decreto 206/2026; el esperado (832/2026) quedó segundo         | 0,647 y 0,640 |
| Prórroga del impuesto a los combustibles       | Decretos 693/2026 y 562/2026; el esperado (829/2026) quedó tercero            | 0,662 a 0,667 |

Son decretos que se dictan cada pocos meses con los mismos artículos y otros
montos o fechas. La búsqueda no devuelve algo equivocado: devuelve una versión
anterior de la misma disposición, con una diferencia de similitud de milésimas.
El embedding no distingue "septiembre de 2026" de "abril de 2025".

En un caso la evaluación es la que se queda corta: para la venta del material
rodante de Belgrano Cargas salió primero el Decreto 718/2026, que modifica al
282/2026 esperado. Es una respuesta válida.

### Próximos pasos

- Elegir la configuración del índice midiendo: `npm run eval -- --sweep` compara
  la búsqueda exacta con varios valores de `ef_search`, en calidad y en tiempo
  por consulta.
- Decidir cómo tratar las normas repetidas: ante similitudes casi iguales,
  preferir la más reciente, que es la que rige.
- Revisar las preguntas de referencia para que acepten más de una norma cuando
  varias responden, y sumar preguntas en inglés.

## Búsqueda por número de norma — 4 de octubre de 2026

Se agregó la búsqueda exacta por tipo, número y año cuando la pregunta cita una
norma (decisión 27). No es un arreglo para la medición anterior, que ya mostró
que el problema era el índice: es un requisito de una herramienta legal. Una
norma citada por su número tiene que aparecer siempre, sin depender del modelo
ni de la configuración del índice.

Efecto en la evaluación: las cuatro preguntas por número quedan primeras con
cualquier configuración. Por eso las mediciones del índice se hacen con
`--semantic-only` (el barrido `--sweep` ya lo hace): de otro modo la búsqueda
por número taparía lo que el índice pierde.

## Configuración del índice — 4 de octubre de 2026

`npm run eval -- --sweep`: la búsqueda por similitud sola, exacta y con cinco
valores de `hnsw.ef_search` (cuántos candidatos mantiene el índice mientras
recorre el grafo). El tiempo es el de la consulta a la base, sin el embedding de
la pregunta.

| Búsqueda         | R@1  | R@3  | R@5  | R@10 | MRR   | Tiempo por pregunta |
| ---------------- | ---- | ---- | ---- | ---- | ----- | ------------------- |
| Exacta           | 61 % | 83 % | 89 % | 89 % | 0,728 | 133 ms              |
| `ef_search` 40   | 44 % | 67 % | 72 % | 72 % | 0,561 | 4 ms                |
| `ef_search` 100  | 61 % | 83 % | 89 % | 89 % | 0,728 | 5 ms                |
| `ef_search` 200  | 61 % | 83 % | 89 % | 89 % | 0,728 | 128 ms              |
| `ef_search` 400  | 61 % | 83 % | 89 % | 89 % | 0,728 | 140 ms              |
| `ef_search` 1000 | 61 % | 83 % | 89 % | 89 % | 0,728 | 27 ms               |

**Decisión: `ef_search = 100`.** Devuelve lo mismo que la búsqueda exacta en las
18 preguntas y tarda 5 ms en lugar de 133. El valor por defecto de pgvector, 40,
era el que perdía respuestas.

### Por qué 200 y 400 tardan como la búsqueda exacta

Porque con esos valores PostgreSQL deja de usar el índice. El planificador
estima el costo del índice en función de `ef_search`; a partir de cierto valor
calcula que le conviene recorrer toda la tabla y ordenar, que es la búsqueda
exacta. Lo comprobé con `EXPLAIN` sobre una tabla sintética del mismo tamaño
(41.275 vectores de 1.024 dimensiones): índice con 40, 100 y 150; recorrido
secuencial con 200 y 400; índice otra vez con 1000. Coincide con los tiempos
medidos. En la base real no miré el plan.

Dos consecuencias:

- Subir `ef_search` "por las dudas" no es gratis ni lineal: pasado un punto, el
  índice deja de usarse y la consulta tarda unas 25 veces más.
- A este tamaño, la búsqueda exacta (133 ms) también sería aceptable. El índice
  se justifica por lo que viene: el costo de la exacta crece con el corpus, y el
  del índice casi no.

### Qué queda

Con la búsqueda por número y `ef_search = 100`, lo que falta son las normas que
se repiten casi iguales: las dos preguntas que ni la búsqueda exacta resuelve.

## Preguntas sin respuesta en el corpus — 4 de octubre de 2026

Dos búsquedas sobre temas que el corpus no cubre (lo que regula mascotas es
anterior al recorte de cinco años, o está en resoluciones):

| Pregunta                             | Qué devolvió                                               | Similitud     |
| ------------------------------------ | ---------------------------------------------------------- | ------------- |
| normativas relacionadas con mascotas | Decretos sobre zoonosis, ganado, fauna y "marco normativo" | 0,520 a 0,558 |
| castrar perros                       | Un artículo sobre animales sueltos en la vía pública       | 0,469         |

El modelo fue en la dirección correcta (animales), pero la búsqueda mostraba 20
resultados como si fueran respuestas. Dos de ellos aparecían por la palabra
"normativas" y no por "mascotas".

En las mediciones anteriores, el primer fragmento de la norma correcta tuvo
entre 0,59 y 0,82 de similitud. Con esos pocos datos se fijó un piso
**provisional de 0,57** (decisión 28) y se sumaron a la evaluación cinco
preguntas sin respuesta, que deben volver vacías.

Falta confirmarlo: `npm run eval` muestra ahora la similitud del fragmento más
cercano y la del primer fragmento esperado en cada pregunta, y
`npm run eval -- --floors` compara varios pisos. No se conoce todavía la
similitud de las respuestas correctas a las preguntas en inglés; si queda por
debajo de 0,57, el piso hay que bajarlo o tratarlas aparte.

## Piso de similitud — 6 de octubre de 2026

`npm run eval` y `npm run eval -- --floors` sobre 23 preguntas: las 18 con
respuesta y cinco sobre temas que el corpus no cubre, que deben volver vacías.

| Piso        | R@1  | R@5  | MRR   | Preguntas sin respuesta rechazadas |
| ----------- | ---- | ---- | ----- | ---------------------------------- |
| Sin piso    | 61 % | 89 % | 0,728 | 0 de 5                             |
| 0,50 a 0,56 | 61 % | 89 % | 0,728 | 4 de 5                             |
| **0,57**    | 61 % | 89 % | 0,728 | **5 de 5**                         |
| 0,58        | 61 % | 89 % | 0,728 | 5 de 5                             |
| 0,60        | 56 % | 78 % | 0,645 | 5 de 5                             |
| 0,62        | 44 % | 67 % | 0,534 | 5 de 5                             |
| 0,65        | 39 % | 50 % | 0,439 | 5 de 5                             |

**Decisión: se confirma 0,57.** Conserva todas las respuestas correctas y
rechaza las cinco preguntas sin respuesta.

### El margen es angosto

| Qué                                                                      | Similitud     |
| ------------------------------------------------------------------------ | ------------- |
| Respuesta correcta más baja (convenio con San Marino)                    | 0,598         |
| Primer fragmento esperado más bajo (Belgrano Cargas, segundo puesto)     | 0,590         |
| Pregunta sin respuesta más alta ("normativas relacionadas con mascotas") | 0,561         |
| Resto de las preguntas sin respuesta                                     | 0,385 a 0,477 |

La ventana que funciona va de 0,562 a 0,589: menos de tres centésimas. Con 0,56
pasa la pregunta de mascotas; con 0,60 se pierden dos respuestas correctas. El
piso separa bien lo que no tiene ninguna relación (ajedrez, empanadas: 0,39 a
0,48) y apenas lo que es vecino del tema (mascotas frente a zoonosis y ganado).

Lo que se concluye:

- Un piso fijo alcanza para estas 23 preguntas, pero no es una garantía. Hay que
  volver a correr `--floors` cuando cambie el corpus o el modelo.
- Para los casos vecinos, el segundo filtro es el modelo de lenguaje de la etapa
  5, que lee los fragmentos y decide si respaldan una respuesta.
- Las dos preguntas en inglés tuvieron 0,641 y 0,604: el piso no las afecta.

### Tiempo de búsqueda

La corrida normal informó 134 ms por pregunta, contra los 5 ms del barrido con
el mismo `ef_search`. La explicación más probable es la caché fría: fue la
primera corrida después de reiniciar el equipo, y el barrido hacía una pasada de
calentamiento que la corrida normal no hacía. No está confirmado. Desde ahora
las dos hacen esa pasada; si el tiempo sigue alto, hay que mirar el plan de la
consulta.

## Ampliación del corpus — 6 de octubre de 2026

Se decidió sumar todas las leyes y decretos-ley (decisión 29). Las mediciones de
arriba son del corpus anterior: 5.069 normas y 41.275 fragmentos.

Cambios en las preguntas de referencia, que pasan de 23 a 27:

- "Prohibición de las carreras de galgos" y "Normativas relacionadas con
  mascotas" dejan de ser preguntas sin respuesta: ahora deben encontrar las
  leyes 27.330, 14.346 o 22.953.
- Dos preguntas nuevas sobre esas leyes: la pena por maltrato animal y la
  vacunación antirrábica.
- "Castrar perros" sigue sin respuesta, porque el decreto que lo regula es de 2011. Se suman dos preguntas ajenas al derecho para mantener cinco.

Pendiente, con el corpus nuevo cargado: `npm run eval`, `--floors` y `--sweep`.
El piso de 0,57 y `ef_search` 100 se eligieron con la sexta parte de los
fragmentos; hay que confirmar que siguen sirviendo.

### Primera corrida con el corpus a medio cargar

La descarga se cortó en la página 372 y la generación de vectores en el
fragmento 2.048 (decisión 30). Con lo que había cargado:

- **Velocidad de embeddings: unos 31 fragmentos por segundo** en la placa del
  equipo de desarrollo.
- **El tiempo de búsqueda vuelve a 7 ms**: los 134 ms de la corrida anterior
  eran la caché fría después de reiniciar, como se suponía.
- Las 18 preguntas con respuesta dan lo mismo que antes y las cinco sin
  respuesta se rechazan.
- En el barrido, `ef_search` 200 ahora usa el índice (6 ms) y 400 no (140 ms).
  El punto en que PostgreSQL deja de usar el índice se movió al crecer la tabla:
  otra razón para medirlo y no fijarlo de memoria.

Las cuatro preguntas sobre las leyes de animales todavía no se midieron: esas
leyes no tenían vectores.

## Corpus ampliado: mediciones — 6 de octubre de 2026

Carga completa después de los arreglos de la decisión 30.

| Dato                    | Valor                                                    |
| ----------------------- | -------------------------------------------------------- |
| Normas                  | 34.973                                                   |
| Páginas descargadas     | 8.529 (372 antes del corte y 8.157 después), 0 fallos    |
| Normas con solo resumen | 23.458                                                   |
| Fragmentos nuevos       | 170.684                                                  |
| Vectores generados      | 171.642 en 84 minutos (34 por segundo), ninguno apartado |

Ningún fragmento quedó apartado: el error que había cortado la corrida anterior
fue una caída pasajera del servidor de modelos, no un texto.

Las preguntas son 27: 22 con respuesta y 5 sin respuesta en el corpus.

### Índice

| Búsqueda         | R@1  | R@3  | R@5  | MRR   | Tiempo por pregunta |
| ---------------- | ---- | ---- | ---- | ----- | ------------------- |
| Exacta           | 55 % | 82 % | 86 % | 0,689 | 682 ms              |
| `ef_search` 40   | 45 % | 73 % | 77 % | 0,596 | 5 ms                |
| `ef_search` 100  | 55 % | 82 % | 86 % | 0,690 | 7 ms                |
| `ef_search` 200  | 55 % | 82 % | 86 % | 0,690 | 9 ms                |
| `ef_search` 400  | 55 % | 82 % | 86 % | 0,690 | 15 ms               |
| `ef_search` 1000 | 55 % | 82 % | 86 % | 0,689 | 646 ms              |

- **`ef_search` 100 se mantiene**: sigue devolviendo lo mismo que la búsqueda
  exacta.
- **Ahora el índice se justifica solo.** Con cinco veces más fragmentos, la
  búsqueda exacta pasó de 133 a 682 ms; la del índice, de 5 a 7 ms. Son cien
  veces de diferencia.
- El punto en que PostgreSQL deja de usar el índice volvió a moverse: ahora lo
  usa con 400 y lo abandona con 1000.

### Piso de similitud: hubo que bajarlo

| Piso        | R@5  | MRR   | Preguntas sin respuesta rechazadas |
| ----------- | ---- | ----- | ---------------------------------- |
| Sin piso    | 86 % | 0,690 | 0 de 5                             |
| 0,50        | 86 % | 0,690 | 3 de 5                             |
| 0,52        | 86 % | 0,690 | 4 de 5                             |
| 0,54 y 0,56 | 86 % | 0,690 | 5 de 5                             |
| 0,57        | 82 % | 0,668 | 5 de 5                             |
| 0,60        | 73 % | 0,596 | 5 de 5                             |

Con 0,57, el piso elegido con el corpus anterior, se perdía una respuesta
correcta: el fragmento de la Ley 27.330 para "prohibición de las carreras de
galgos" tiene 0,566. Del otro lado, "castrar perros" subió de 0,413 a 0,533,
porque ahora hay leyes sobre animales cerca del tema.

**Decisión: el piso pasa a 0,55.** La ventana que funciona va de 0,534 a 0,566.
Con cualquier valor en ese rango se conservan las respuestas y se rechazan las
cinco preguntas sin respuesta.

Lo que deja en claro: el piso no es una propiedad del modelo sino del corpus.
Cambió el contenido y cambió el valor. Una pregunta nueva tuvo su respuesta
correcta en 0,566, por debajo del piso anterior, y un tema vecino sin respuesta
subió a 0,533. La ventana se corrió hacia abajo y sigue siendo angosta.

### Pregunta por pregunta

- Las 18 preguntas anteriores dan lo mismo, salvo una: "Social security
  agreement between Argentina and San Marino" pasó del primer puesto al segundo
  (0,641 contra 0,651 de otra norma). Con todas las leyes cargadas hay más
  convenios de seguridad social compitiendo.
- "¿Qué pena tiene el maltrato o la crueldad contra los animales?" encuentra
  primera la Ley 14.346 (0,666), y "vacunación antirrábica obligatoria de perros
  y gatos", la Ley 22.953 (0,631). Antes de ampliar el corpus no tenían
  respuesta posible.
- "Normativas relacionadas con mascotas" encuentra una de las tres leyes
  esperadas recién en el puesto 12 (0,575; el primer resultado tiene 0,598).
  Falta mirar qué sale antes: puede haber otras normas sobre animales que
  también sean respuestas válidas.
- Siguen sin resolverse las dos de normas repetidas (servicios extraordinarios y
  Antártida).

### Tamaño final

| Dato                  | Valor    |
| --------------------- | -------- |
| Fragmentos            | 211.770  |
| Fragmentos con vector | 211.770  |
| Tabla de fragmentos   | 2.953 MB |
| Índice HNSW           | 1.652 MB |

### Qué devuelve la pregunta de mascotas

Con `--verbose`, "Normativas relacionadas con mascotas" trae primero leyes
sobre animales que no son de compañía: la Ley 23.899 (SENASA), la Ley 22.421
(fauna silvestre), la Ley 24.696 (brucelosis) y el Decreto-Ley 5153/1945
(ganadería). Las tres leyes esperadas aparecen recién en el puesto 12.

No es un problema del índice ni del piso: es de vocabulario. Ninguna de las
leyes esperadas usa la palabra "mascota". Dicen "animales", "perros", "canes",
"gatos". Para el modelo, "mascotas" queda tan cerca de "sanidad animal" como de
"malos tratos a los animales".

Las normas que salen primero no son disparates, pero tampoco son lo que busca
quien pregunta por mascotas. No las sumo como respuestas válidas: sería ajustar
la vara al resultado.

**Qué hacer**: reescribir la pregunta antes de buscar ("mascotas" → "animales
domésticos, perros, gatos"). Es trabajo del modelo de lenguaje y entra en la
etapa 5. Antes se puede comprobar a mano si la idea rinde, comparando
`npm run search -- "mascotas"` con
`npm run search -- "animales domésticos perros gatos"`.

### Qué queda

- Las normas que se repiten casi iguales: sección siguiente.
- La brecha de vocabulario en las preguntas amplias: etapa 5.

## Versiones de una misma disposición — 6 de octubre de 2026

Qué se ve con `--verbose` en las preguntas que siguen fallando:

| Pregunta                  | Esperada                      | Qué sale antes                                              |
| ------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Adicional antártico       | Decreto 834/2026, puesto 14   | Decretos 294/2025, 578/2025, 113/2025, 553/2026 y 1040/2024 |
| Servicios extraordinarios | Decreto 832/2026, fuera de 20 | Decretos 112/2025, 1038/2024, 468/2024, 293/2025 y 206/2024 |

En la primera, los cinco de arriba tienen entre 0,818 y 0,825 y la esperada,
0,810. En la segunda, los cinco están entre 0,708 y 0,712. Son el mismo artículo
reeditado: la similitud no puede distinguirlos, y tampoco debería. Lo que
corresponde es mostrarlos como lo que son, versiones de una disposición, con la
más reciente adelante (decisión 31).

Lo mismo pasa, en menor medida, con Garrahan, bibliotecarios y combustibles.

### Comprobado sin el modelo real

Con un servidor de embeddings de prueba (vectores por hash, no por significado)
el mecanismo agrupa y ordena bien, y dejó a la vista un error: juntaba dos
decretos del mismo día. De ahí salió la regla de los días distintos.

Esos vectores no sirven para elegir el umbral. Cuán parecidos son para bge-m3
dos artículos reeditados solo se puede medir con bge-m3.

## Versiones: primera medición — 7 de octubre de 2026

`npm run eval -- --versions-sweep`, 22 preguntas con respuesta, piso 0,55:

| Umbral  | R@1  | R@3  | R@5  | R@10 | MRR   | Fragmentos agrupados |
| ------- | ---- | ---- | ---- | ---- | ----- | -------------------- |
| Apagado | 55 % | 82 % | 86 % | 86 % | 0,690 | 0                    |
| 0,99    | 55 % | 82 % | 86 % | 86 % | 0,690 | 0                    |
| 0,98    | 55 % | 82 % | 86 % | 86 % | 0,690 | 7                    |
| 0,97    | 55 % | 82 % | 86 % | 86 % | 0,691 | 46                   |
| 0,96    | 55 % | 82 % | 86 % | 95 % | 0,699 | 149                  |
| 0,95    | 64 % | 86 % | 95 % | 95 % | 0,767 | 250                  |
| 0,93    | 68 % | 91 % | 95 % | 95 % | 0,801 | 342                  |
| 0,90    | 73 % | 91 % | 95 % | 95 % | 0,833 | 412                  |

Las cinco preguntas sin respuesta se rechazan con todos los umbrales. El tiempo
por pregunta sube de 9 a 24 ms: se traen 100 fragmentos en lugar de 20, con sus
vectores.

**Lo que mejora** (con 0,95): el adicional antártico pasa del puesto 14 al 2;
los servicios extraordinarios, de fuera de los 20 al 4; Garrahan y
bibliotecarios, al primero.

Los números invitan a bajar el umbral. Antes de elegirlo miré qué quedó
agrupado, y aparecieron tres cosas que la tabla no muestra.

### 1. Una misma serie queda partida en varios grupos

Para el adicional antártico, con 0,95:

| Puesto | Encabeza         | Debajo                                               |
| ------ | ---------------- | ---------------------------------------------------- |
| 1      | Decreto 208/2026 | 578/2025, 294/2025, 113/2025, 1040/2024, 838/2024... |
| 2      | Decreto 834/2026 | 553/2026, 66/2026                                    |
| 3      | Decreto 726/2022 | 352/2022, 290/2022, 135/2022, 743/2021               |
| 4      | Decreto 686/2024 | 470/2024                                             |
| 5      | Decreto 207/2024 | 287/2023                                             |

Es una sola serie. Por fecha, los cuatro de 2026 van así: 66 (enero), 208
(marzo), 553 (junio), 834 (agosto). El 208 quedó en un grupo y sus vecinos de
enero y de junio en otro, y el primer resultado lo encabeza un decreto de marzo
cuando existe el de agosto.

La causa es cómo se arman los grupos: cada fragmento se compara solo con el
mejor ubicado de su grupo. Entre dos reediciones la similitud va de 0,945 a
0,971, así que un umbral de 0,95 cae en el medio de esa franja y corta la serie
por donde toque. Bajar el umbral lo disimula; no lo corrige.

### 2. Parecerse no es reemplazar

- **Reedición que reemplaza**: el tope de servicios extraordinarios. Cada
  decreto fija montos nuevos; el anterior deja de aplicarse.
- **Acto nuevo de la misma serie**: las homologaciones del SINEP. Los decretos
  833, 565, 207 y 37 de 2026 homologan cada uno un acta distinta. Quien busca
  la del 28 de mayo necesita el 565, no el más reciente.
- **Normas distintas con el mismo encabezado**: los decretos 581/2026 y
  866/2025 quedaron agrupados con 0,972. Los dos modifican el organigrama del
  Decreto 50/2019, pero uno transfiere oficinas a la Vocería Presidencial y el
  otro suprime la Secretaría de Comunicación y Medios. Lo que se parece es el
  "visto y considerando".

El tercer caso tiene una similitud más alta (0,972) que casi todas las
reediciones verdaderas. Ningún umbral los separa.

Consecuencia: el agrupamiento no puede afirmar que una norma reemplaza a otra.
Lo que puede decir es "hay normas anteriores con un texto casi idéntico". Así
hay que presentarlo, y así hay que medirlo: lo que gana la pregunta que busca
la última versión contra lo que pierde la que busca una anterior.

### 3. Dos preguntas esperaban menos de lo correcto

Leí los textos de dos normas que salían antes que la esperada:

- **Belgrano Cargas**: el Decreto 718/2026 sustituye el artículo 1 del 282/2026.
  El destino actual de lo producido por la venta está en el 718.
- **Ciberseguridad**: el Decreto 581/2026 vuelve a enunciar los objetivos de la
  Secretaría de Innovación, Ciencia y Tecnología, incluido el de
  ciberseguridad.

Las dos preguntas aceptan ahora cualquiera de las dos normas. No es ajustar la
vara al resultado: en los dos casos la respuesta está en el texto que leí. Sí
cambia la línea de base, y por eso la medición siguiente vuelve a incluir la
fila "apagado".

### Qué se cambió

- **Segunda forma de armar los grupos** (`--versions-link chain`): un fragmento
  se une a un grupo si se parece a cualquiera de sus miembros, empezando por los
  pares más parecidos. Mantiene junta una serie aunque la primera y la última
  edición ya no se parezcan tanto. El riesgo es el inverso: unir series
  distintas a través de una norma intermedia. La forma anterior queda como
  `best`.
- **Tres preguntas de tipo `earlier`**, que piden una edición que no es la
  última: el acta del SINEP del 28 de mayo (Decreto 565/2026), el tope de
  servicios extraordinarios desde junio (552/2026) y la supresión de la
  Secretaría de Comunicación y Medios (866/2025).
- **Dos columnas nuevas en `--versions-sweep`**: el recall de esas tres
  preguntas, y cuántas respuestas quedaron solo debajo de otra norma.
- En `--verbose`, `^N` indica que la norma esperada no es un resultado propio:
  está listada debajo del resultado N.

## Versiones: segunda medición — 7 de octubre de 2026

`npm run eval -- --versions-sweep`, con las dos preguntas corregidas. La línea
de base ("apagado") subió por esa corrección: R@1 de 55 % a 64 % y MRR de 0,690
a 0,749.

| Forma   | Umbral | R@1  | R@3  | R@5  | MRR   | `earlier` R@5 | Bajo otra norma | Agrupados |
| ------- | ------ | ---- | ---- | ---- | ----- | ------------- | --------------- | --------- |
| Apagado | —      | 64 % | 86 % | 86 % | 0,749 | 67 %          | 0               | 0         |
| `best`  | 0,96   | 64 % | 86 % | 86 % | 0,758 | 67 %          | 0               | 167       |
| `best`  | 0,95   | 73 % | 91 % | 95 % | 0,826 | 33 %          | 1               | 288       |
| `best`  | 0,93   | 77 % | 95 % | 95 % | 0,860 | 0 %           | 2               | 413       |
| `best`  | 0,92   | 82 % | 95 % | 95 % | 0,890 | 33 %          | 2               | 440       |
| `chain` | 0,97   | 64 % | 86 % | 86 % | 0,753 | 67 %          | 0               | 99        |
| `chain` | 0,96   | 73 % | 91 % | 95 % | 0,823 | 33 %          | 1               | 267       |
| `chain` | 0,95   | 82 % | 95 % | 95 % | 0,883 | 67 %          | 1               | 371       |
| `chain` | 0,94   | 82 % | 95 % | 95 % | 0,890 | 67 %          | 1               | 437       |
| `chain` | 0,93   | 82 % | 95 % | 95 % | 0,890 | 67 %          | 2               | 481       |
| `chain` | 0,90   | 82 % | 95 % | 95 % | 0,890 | 67 %          | 2               | 577       |

Las cinco preguntas sin respuesta se rechazan en todas las filas.

### Lectura

- **`best` gana de un lado lo que pierde del otro.** Para llegar a R@1 de 82 %
  hay que bajar el umbral a 0,92, y las preguntas `earlier` caen de 67 % a
  33 %. Es lo que anticipaba la primera medición: parte las series, y una
  edición anterior queda enterrada debajo de un grupo ajeno.
- **`chain` con 0,95 llega al mismo 82 % sin tocar `earlier`**, que queda en
  67 %, igual que con el agrupamiento apagado.
- Con `chain`, las series aparecen enteras. El adicional antártico: Decreto
  834/2026 primero, con el 553, el 208 y el 66 de 2026 y los de 2025 debajo. El
  tope de servicios extraordinarios: Decreto 832/2026 primero, con 22 ediciones
  anteriores debajo; estaba fuera de los 20 primeros.
- La serie del adicional antártico sigue en dos grupos: las ediciones hasta el
  Decreto 207/2024, donde es el artículo 7, y las posteriores, donde es el
  artículo 5. Entre unas y otras los textos ya no llegan al umbral.
- **"Bajo otra norma: 1"** es la pregunta por el tope desde junio de 2026. El
  artículo 3 del Decreto 552/2026 queda listado debajo del 832/2026, en el
  primer resultado, y la norma aparece además por sí misma en el puesto 4.

**Decisión: agrupamiento encendido, forma `chain`, umbral 0,95.** Entre 0,95 y
0,94 los números son casi iguales (una pregunta sube del tercer puesto al
segundo). Elijo 0,95 por dos razones: es el umbral cuyos grupos revisé uno por
uno, y 25 preguntas no alcanzan para medir todas las uniones falsas que un
umbral más bajo puede producir. De 0,93 para abajo ya son dos las respuestas
que quedan debajo de otra norma.

**Costo**: 27 ms por pregunta en lugar de 9.

### Lo que el agrupamiento no arregla

- **Las fechas.** Las tres preguntas `earlier` tienen R@1 de 0 % con el
  agrupamiento apagado y encendido. Para "acta del 28 de mayo de 2026 del
  SINEP", el Decreto 833/2026 (acta del 25 de agosto) tiene 0,787 y el 565/2026,
  que es la respuesta, 0,781. El modelo casi no distingue una fecha de otra.
  Elegir entre ediciones por fecha es trabajo para la etapa 5.
- **El par 581/2026 y 866/2025** sigue agrupado (0,972): son normas distintas
  con el mismo encabezado. Queda presentado como lo que es, un texto casi
  idéntico en una norma anterior.
- **La pregunta por el Decreto 866/2025 no se encuentra** entre los 20 primeros,
  con el agrupamiento apagado o encendido, así que no mide lo que quería medir.
  El fragmento existe y está bien cortado: procesé la página y el artículo 1 es
  un fragmento propio de 289 caracteres. Falta saber si lo saltea el índice o
  si el modelo lo puntúa bajo; `npm run eval -- --exact --verbose` lo dice.

## Confirmación con los valores por defecto — 7 de octubre de 2026

`npm run eval`, con el agrupamiento ya encendido (cadena, 0,95):

| Preguntas               | R@1   | R@3   | R@5   | MRR   |
| ----------------------- | ----- | ----- | ----- | ----- |
| Todas (25)              | 72 %  | 88 %  | 92 %  | 0,807 |
| Por tema (16)           | 81 %  | 94 %  | 94 %  | 0,870 |
| Por número de norma (4) | 100 % | 100 % | 100 % | 1,000 |
| En inglés (2)           | 50 %  | 100 % | 100 % | 0,750 |
| Edición anterior (3)    | 0 %   | 33 %  | 67 %  | 0,250 |

Sin respuesta en el corpus: 5 de 5 rechazadas. 28 ms por pregunta. Coincide con
lo que anticipaba el barrido.

### El costo, mejor medido

La misma corrida con búsqueda exacta y sin agrupar (`--exact --versions off`)
permite comparar pregunta por pregunta contra la búsqueda por defecto (con
índice y agrupando):

| Pregunta                                  | Sin agrupar | Agrupando   |
| ----------------------------------------- | ----------- | ----------- |
| Adicional antártico                       | 14          | 1           |
| Tope de servicios extraordinarios         | fuera de 20 | 1           |
| Residentes del Garrahan                   | 2           | 1           |
| Escuela Nacional de Bibliotecarios        | 2           | 1           |
| Acta del SINEP del 28 de mayo (`earlier`) | 2           | 2           |
| Tope de servicios desde junio (`earlier`) | 2           | 4           |
| Supresión de una secretaría (`earlier`)   | fuera de 20 | fuera de 20 |

En la segunda medición escribí que las preguntas `earlier` no se veían
afectadas. Era cierto para el recall@5, que es lo que mostraba el barrido, y
no del todo: **el tope de servicios desde junio baja del puesto 2 al 4**. El
artículo del Decreto 552/2026 queda listado debajo del 832/2026, en el primer
resultado, y la norma vuelve a aparecer por sus anexos. El MRR de ese grupo
pasa de 0,333 a 0,250.

La decisión no cambia: cuatro preguntas pasan al primer puesto, dos de ellas
desde muy lejos, y la que baja sigue a la vista en el primer resultado. Pero el
costo existe y es este.

### La pregunta que el modelo no encuentra

"Decreto que suprime la Secretaría de Comunicación y Medios del organigrama de
la Administración Nacional" no encuentra el Decreto 866/2025 ni con búsqueda
exacta. No es el índice ni el agrupamiento: es el modelo, que puntúa ese
artículo por debajo de los veinte primeros (el quinto resultado tiene 0,643).

El artículo dice "Suprímese del Anexo I -Organigrama de Aplicación de la
Administración Nacional centralizada hasta nivel de Subsecretaría-, aprobado por
el artículo 1° del Decreto N° 50 del 19 de diciembre de 2019 y sus
modificatorios, el Apartado IV TER, SECRETARÍA DE COMUNICACIÓN Y MEDIOS". Dos
tercios del texto son la fórmula de remisión, que comparten decenas de artículos
de otros decretos. Es una hipótesis, no una medición.

La pregunta se queda en el conjunto: es un fallo real y sirve para medir
cualquier mejora futura (reescritura de la pregunta, reordenamiento).

### Configuración del índice, con las 25 preguntas

`npm run eval -- --sweep`, solo similitud:

| Búsqueda         | R@1  | R@5  | MRR   | Tiempo por pregunta |
| ---------------- | ---- | ---- | ----- | ------------------- |
| Exacta           | 56 % | 84 % | 0,699 | 622 ms              |
| `ef_search` 40   | 52 % | 76 % | 0,636 | 5 ms                |
| `ef_search` 100  | 56 % | 84 % | 0,700 | 8 ms                |
| `ef_search` 200  | 56 % | 84 % | 0,699 | 9 ms                |
| `ef_search` 400  | 56 % | 84 % | 0,699 | 15 ms               |
| `ef_search` 1000 | 56 % | 84 % | 0,699 | 611 ms              |

`ef_search` 100 se mantiene. La milésima de diferencia en el MRR es la pregunta
de mascotas: la búsqueda exacta pone la ley esperada en el puesto 16 y el índice
en el 12, porque saltea cuatro fragmentos que la exacta sí devuelve antes. Es la
aproximación del índice a la vista, y no cambia ningún recall.

### Qué queda para la etapa 5

- Preguntas amplias: reescribir la pregunta antes de buscar.
- Elegir entre ediciones por su fecha: el modelo de lenguaje recibe las fechas
  de cada resultado y de las normas listadas debajo.
- La pregunta por el Decreto 866/2025.
