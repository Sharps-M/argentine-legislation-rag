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

### Lectura

Son hipótesis hasta revisar qué devolvió la búsqueda en cada caso
(`npm run eval -- --verbose`) y descartar que el índice aproximado haya salteado
resultados (`npm run eval -- --exact`).

1. **Pedir una norma por su número es el punto débil.** Un embedding representa
   el significado de un texto, no sus cifras: "Ley 27818" y "Ley 27817" quedan
   casi en el mismo lugar. Dos de las cuatro preguntas por número fallaron; las
   otras dos acertaron ayudadas por el encabezado de contexto.
2. **Normas que se repiten casi iguales.** Los decretos que homologan actas
   salariales salen cada pocos meses con los mismos artículos y otros montos. Es
   probable que la búsqueda haya devuelto un decreto anterior equivalente, que
   para la evaluación cuenta como error.
3. **Inglés.** Un acierto y un fallo; con dos preguntas no se puede concluir
   nada.

### Próximos pasos

- Detectar en la pregunta una referencia del tipo "Ley 27818" o
  "Decreto 833/2026" y buscar esa norma por tipo y número, sin depender del
  embedding.
- Evaluar una búsqueda híbrida: texto completo de PostgreSQL más vectores,
  combinados por posición.
- Sumar preguntas, sobre todo en inglés.
