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
