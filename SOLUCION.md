# SOLUCION — Agente de registro como proveedor

## 1. Problema en una frase

Periferia recibe entre 8 y 12 solicitudes al mes de registro como proveedor en Colombia, Ecuador, Perú, Panamá y Honduras, y cada una se transcribe a mano desde un repositorio interno hacia una plantilla Excel, un PDF o un portal web. Le duele a la analista administrativa, que pierde horas en transcripción, y a la facturación, que espera días por cada registro.

## 2. Arquitectura

```
┌──────────────┐  POST /api/chat   ┌────────────────────────────────────────────┐
│  Front: chat │ ────────────────▶ │  Backend (Express)                         │
│  web/        │ ◀──────────────── │  server.ts  sesiones · confirmación        │
│  historial   │  reply, toolCalls │      │                                     │
│  tool calls  │  needsConfirmation│      ▼                                     │
│  diálogo     │                   │  ciclo.ts  prompt → modelo → herramientas  │
│  Aceptar/    │                   │      │   tope 25 · tokens · CA2            │
│  Cancelar    │                   │      ▼                                     │
└──────────────┘                   │  llm/anthropic.ts  (Claude, tool_use)      │
                                   │  tools/  proveedor_* (zod, nunca lanzan)   │
                                   └──────┬───────────────────────┬─────────────┘
                                          │                       │
                              fixtures/ (solo lectura)     out/ (escritura)
```

Separación que evaluamos:

| Qué | Dónde | Por qué |
|---|---|---|
| Comportamiento del agente | `agent/prompt.md` | Cambiar reglas de conversación no toca código. |
| Conocimiento del proceso | `src/knowledge/registro-proveedor.md` | Quién es el proveedor, RN1–RN5, herramientas. |
| Ejecución | `src/tools/` | Cada herramienta valida con zod y devuelve `{ok,data}` o `{ok,error}`. |
| Ciclo y seguridad | `src/ciclo.ts`, `src/server.ts` | Tope, confirmación y tokens no dependen del modelo. |

## 3. Ciclo del agente

**Bucle.** `ejecutarTurno` envía el historial y las definiciones de herramientas al modelo. Si el modelo pide herramientas, las ejecuta, agrega los resultados al historial y vuelve a llamar al modelo. Termina cuando el modelo responde sin herramientas.

**Tope de iteraciones (CA1).** `MAX_ITER` (25 por defecto). Al alcanzarlo, el turno responde con los resultados parciales y lo que falta, sin lanzar excepción.

**Tope de tokens por sesión (costo).** El adaptador devuelve el consumo de cada llamada. El servidor lo acumula por sesión; al superar `TOKENS_SESION` no vuelve a llamar al modelo y lo explica en el chat.

**Errores del proveedor (HU-5, CA5).** Un fallo se clasifica en timeout, HTTP (con código) o desconocido, y se muestra en lenguaje claro. Un 429 indica cuota o créditos agotados; un 401 indica que la clave fue rechazada. El mensaje nunca incluye la clave ni una traza. El fallo queda en `out/log.jsonl` como `error_llm`.

**Confirmación humana (CA3, RN4).** El modelo nunca puede confirmar un envío. Su herramienta `proveedor_simular_envio` se le expone solo con el parámetro `caso`. Al llamarla, el servidor no ejecuta el envío: emite un `actionId` de un solo uso y responde `needsConfirmation: true`. El front muestra el diálogo Aceptar/Cancelar. Solo si la analista acepta, en el turno inmediato siguiente y con el `actionId` vigente, el servidor ejecuta la herramienta real con `confirmado: true`. Un `actionId` viejo o reutilizado se rechaza y no crea nada.

**Memoria de sesión.** La sesión guarda el historial completo del turno, con llamadas y resultados de herramientas. Así el modelo puede citar lo calculado en turnos anteriores sin repetir llamadas.

**Verificación de valores (CA2).** Las herramientas son la única fuente de valores (PRD 6.3). Después de cada respuesta, el servidor revisa de forma determinista: identificadores (números de 6 dígitos o más, correos y URLs), valores destacados (negrita, comillas) y nombres propios (secuencias con mayúscula inicial). Cada uno debe aparecer en alguna salida exitosa de herramienta de la sesión. Si no, la respuesta añade `⚠ Valores no verificados por herramientas`. Limitación: las palabras comunes del proceso (encabezados, etiquetas, conectores) están en una lista blanca; ver sección 10.

**Observabilidad (CA4, RN5).** Cada llamada a herramienta queda en el chat y en `out/<caso>/log.jsonl` con `{ts, herramienta, ok, resumen}`. El servidor registra además `tool_call`, `envio_simulado`, `envio_fallido`, `limite_tokens` y `error_llm` en `out/log.jsonl`.

## 4. Elección del modelo

**Elegido:** Claude, modelo `claude-haiku-5-5` por defecto, configurable con `LLM_MODEL`. La clave va en `ANTHROPIC_API_KEY`.

**Por qué:**
- El trabajo es llamar herramientas con argumentos tipados. La API de Anthropic expone `tool_use` con esquemas JSON, que mapean directamente a las herramientas zod.
- Haiku es el modelo más económico de la familia y basta para orquestar cuatro o cinco herramientas por caso; el razonamiento de negocio está en el código y en el conocimiento, no en el modelo.
- El adaptador es una interfaz propia (`enviar(mensajes, herramientas)`). Cambiar de proveedor toca solo `src/llm/`.

**Costo medido.** Medido contra la API real en esta sesión, sumando tokens de entrada y salida reportados por la API:

| Escenario | Tokens (acumulado de sesión) |
|---|---|
| Caso PA: procesar + preparar + confirmar + envío | ≈ 26 800 (dos turnos) |
| Caso EC: procesar y reportar faltantes (un turno) | ≈ 16 400 |

**Precio.** Según fuentes secundarias de octubre de 2026 ([MarkTechPost](https://www.marktechpost.com/2026/10/07/anthropic-releases-claude-haiku-5-5-a-small-model-with-1m-context-priced-at-0-10-per-million-input-tokens/) y [VentureBeat](https://venturebeat.com/technology/anthropic-launches-claude-haiku-5-5-with-90-api-price-reduction-matching-gpt-6-luna)), `claude-haiku-5-5` cuesta $0.10 por millón de tokens de entrada y $0.50 por millón de salida con prompts de hasta 100 K tokens. No pude confirmarlo en la página oficial de precios.

**Presupuesto.** Crédito disponible: $5. El tope global `TOKENS_GLOBALES` es 8 000 000 tokens: al peor caso (tarifa de salida, $0.50 por millón) cuesta $4 como máximo, y deja $1 de margen. El límite real debe configurarse también en la consola de Anthropic.

**Costo estimado por caso.** Con esa tarifa, el caso PA completo (≈ 27 K tokens) cuesta como máximo ≈ $0.013 (si todo se cobra a la tarifa de salida) y menos de $0.003 si se cobra todo a la de entrada. Con un presupuesto de $5 alcanzan cientos de casos. El límite `TOKENS_SESION` (50 000 por defecto) acota el gasto de cada sesión.

## 5. Diseño del portal web (PRD 7.4)

**Estrategia.** El formato "portal web con usuario y contraseña" no se automatiza en este reto (HU-3, P2). El agente produce `valores-portal.md` con los nueve valores listos para copiar. Si se quisiera automatizar, la estrategia sería un navegador controlado por el agente (Playwright) que rellena campos a partir de `valores-portal.md`, siempre en modo "preparar, no enviar".

**Límites.** CAPTCHA y MFA rompen la automatización completa; los cambios de layout obligan a mantener selectores; y muchos portales prohíben la automatización en sus términos. Por eso el diseño trata el portal como un paso humano asistido, no como un robot.

**Credenciales.** Nunca en el repositorio, nunca en el prompt, nunca en logs. Vivirían en un gestor de secretos del equipo (por ejemplo, un vault del proveedor de nube) y las ingresa el humano en el navegador, nunca el agente.

**Reparto de tareas.**
- El agente: lee la solicitud, mapea campos, genera los valores copiables, arma el paquete y propone el envío.
- El humano: ingresa usuario y contraseña, revisa los valores en el portal y hace clic en "Enviar".

## 6. Decisiones y trade-offs

1. **Confirmación con `actionId` de un solo uso, no con texto "SI".** Alternativa descartada: que el usuario escriba "SI" en el chat. Un texto libre es ambiguo y el modelo podría generarlo por error. El `actionId` queda ligado al turno y a la sesión, y el servidor lo valida, así que el front no es la defensa.
2. **Herramienta de envío expuesta al modelo sin el parámetro `confirmado`.** Alternativa descartada: pasar `confirmado` y confiar en el prompt. La restricción va en el servidor, no en el texto del prompt.
3. **Adaptador propio del modelo, sin LangChain.** Alternativa descartada: un framework de agentes. Ocultaba el bucle que queremos evaluar y añadía dependencias sin resolver nada del caso.
4. **Sesiones en memoria, sin base de datos.** Alternativa descartada: SQLite. El PRD excluye persistencia en base de datos; la superficie SQL aumentaba el riesgo sin beneficio para un reto de cinco herramientas.
5. **Herramientas en `BaseTool` con contrato `{ok,data}|{ok,error}` que nunca lanza.** Alternativa descartada: funciones sueltas con `try/catch` en cada una. Repetía el contrato en cinco lugares.
6. **Verificación de valores por número, no por texto completo.** Alternativa descartada: verificar cada palabra de la respuesta, lo que daba demasiados falsos positivos. Los identificadores (NIT, RUC, cuentas) son los datos que más duelen si se inventan, y son numéricos.
7. **Tope de tokens por sesión, no solo por turno.** Un usuario podría gastar la clave con muchos turnos cortos; el tope por turno no lo evita.

**Dependencias (PRD 8).** Todas justificadas:

| Paquete | Uso | Por qué este y no otro |
|---|---|---|
| `zod` | Validación de argumentos de herramientas y esquemas que ve el modelo. | Obligatorio por el PRD; genera el JSON Schema de cada herramienta. |
| `express` | API HTTP y front estático. | Mínimo, sin framework de aplicación; suficiente para tres rutas. |
| `exceljs` | Escritura del formulario xlsx en celdas exactas (HU-3 P0). | Permite escribir hoja y celda y releer en pruebas; SheetJS se descartó por control de hoja (design del change). |
| `pdf-lib` | Generación del formulario pdf (HU-3 P1). | Librería pura en JavaScript, sin binarios nativos; control de fuentes y fechas para salida determinista. |
| `tsx` | Ejecución de TypeScript en producción y en `demo.ts`. | Evita un paso de compilación; necesario en `dependencies` para que `npm start` funcione. |
| `vitest`, `@vitest/coverage-v8`, `supertest`, `jsdom`, `unpdf` | Pruebas (solo desarrollo). | `unpdf` extrae texto de los PDF en las pruebas; no entra en producción. El adaptador de Anthropic usa `fetch`, sin SDK, para mantener el adaptador propio. |

## 7. Supuestos

- **El proveedor es siempre Periferia IT Group S.A.S.** (Colombia). Los clientes son quienes piden el registro. El país del cliente solo afecta a RN1.
- Los fixtures representan la variabilidad real: formatos portal, xlsx y pdf.
- La fecha de referencia para vigencias es `2026-09-03`, la del PRD.
- Un soporte vencido **se copia** al paquete (existe en el repositorio) pero **bloquea** `listo_para_firma`.
- El RUC de Panamá y Ecuador se toma del campo NIT del maestro y siempre queda `requiere_confirmacion`, como exige RN1.
- Las etiquetas genéricas "Identificación tributaria" y "Número de identificación fiscal" son ambiguas en cualquier país y siempre se confirman (HU-1).

## 8. Cobertura

| Historia / regla | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Al leer la solicitud, la primera línea de la respuesta dice caso, cliente, país y formato. Si el modelo no lo dice, el servidor antepone esa línea con los datos de la herramienta. |
| HU-2 Mapear campos al maestro | Hecho | Confianza: ≥ 0.8 llena (coincidencia exacta o normalizada, o similitud ≥ 0.8); entre 0.5 y 0.8 pide confirmación con sugerencia; < 0.5 es faltante. Sin confianza, nunca se inventa. |
| HU-3 P0 Excel (`formulario.xlsx`) | Hecho | — |
| HU-3 P1 PDF (`formulario.pdf`) | Hecho | — |
| HU-3 P2 Portal (`valores-portal.md`) | Hecho | La respuesta incluye «formato no soportado» y se entregan los valores copiables. |
| HU-4 Paquete para firma | Hecho | — |
| HU-5 Manejo de errores | Hecho | Plantilla o glosario corruptos devuelven «archivo corrupto: <nombre> no se puede leer» sin traza del parser. Caso inexistente, herramienta desconocida y argumentos inválidos también se explican. |
| Chat: historial, tool-calls, pensando, diálogo, CSP, anti-XSS | Hecho | Pruebas visuales en navegador real. |
| RN1 Identificador tributario por país | Hecho | — |
| RN2 Borrador sin banco | Hecho | — |
| RN3 Vencido/ausente bloquea, faltante no | Hecho | — |
| RN4 Confirmación antes de acción externa | Hecho | — |
| RN5 Log por ejecución | Hecho | — |
| CA1 Tope de iteraciones | Hecho | — |
| CA2 Solo valores de herramientas | Cumple (verificación determinista) | Identificadores, correos, URLs, valores destacados y nombres propios se comparan con las salidas de herramientas de la sesión. Limitación documentada: palabras comunes del proceso están en lista blanca. |
| CA3 Confirmación explícita | Hecho | — |
| CA4 Llamadas visibles y en log | Hecho | — |
| CA5 Errores claros, sesión viva | Hecho | — |
| `demo.ts` sobre todos los casos | Hecho | — |
| Costo: tope de tokens configurable | Hecho | Tabla de precios para el costo en dólares. |
| Seguridad: clave solo en entorno, sin shell | Hecho | Revisión externa. |
| TypeScript sin `any` | Hecho | Verificado con búsqueda en `src/`, `tests/` y `demo.ts`. |
| Enlace público de prueba (9.3) | Hecho | https://reto-01-proveedor.onrender.com, desplegado desde `render.yaml`. Probado en vivo: sección 11 del PRD, confirmación con `actionId` y reuso rechazado. |
| Bonus: módulo reutilizable `modulo/` (9.4) | Hecho | Generado desde las fuentes de la app; una prueba impide que diverja. |
| Entrega en repositorio o zip (9.5) | Pendiente | Inicializar git con historial o generar `reto-01-<apellido>.zip` sin `node_modules/`, `out/` ni `.env`. |

## 9. Uso de IA

**Asistente usado para construir:** Claude Code (Anthropic), con el modelo Claude de la sesión.

**Para qué:**
- Leer el PRD y comparar la implementación contra cada requisito.
- Escribir tests antes que el código (TDD en los changes de OpenSpec) y la implementación posterior.
- Redactar el conocimiento del agente, el prompt y esta documentación.
- Diagnosticar fallos reales contra la API (por ejemplo, el 429 por falta de créditos y la pérdida de memoria entre turnos).

**Qué descarté de lo que se propuso:**
- **Bun.** Descartado; el proyecto usa Node 24 con npm. El PRD acepta ambos.
- **OpenAI como proveedor.** Se implementó primero, luego se reemplazó por Anthropic cuando el responsable del reto lo pidió.
- **Jest.** Descartado en favor de Vitest, que ya estaba en el diseño del change.
- **Texto "SI" para confirmar.** Descartado; el PRD y la decisión del equipo piden un botón.
- **Un "solicitar envío" distinto de "simular envío".** Descartado; el nombre canónico del PRD es `proveedor_simular_envio`.

**Lo que puedo explicar línea por línea:** todo el código de `src/`, `demo.ts` y los tests. Las decisiones están en la sección 6.

## 10. Riesgos y mitigación

| Riesgo | Mitigación actual | Mitigación para producción |
|---|---|---|
| El modelo inventa un valor de texto libre (nombre, dirección). | Verificación determinista de identificadores, valores destacados y nombres propios; las herramientas son la única fuente. | Un valor citado sin formato destacado ni mayúscula inicial (p. ej. una dirección en minúsculas) no se verifica; ver lista blanca. |
| El modelo cambia de comportamiento con una actualización. | Pruebas de integración con el adaptador y medición real por cambio. | Evaluación automatizada con casos dorados antes de cada cambio de modelo. |
| Costo descontrolado. | `TOKENS_SESION` y `MAX_ITER`. | Presupuesto mensual y alertas en el proveedor. |
| Sesiones en memoria se pierden al reiniciar. | Aceptable para el reto (sin persistencia en PRD). | Almacén de sesiones en archivo o base de datos. |
| Datos del maestro desactualizados. | Supuesto explícito (PRD 10). | Un dueño del dato y fecha de última actualización visible. |
| Un soporte vencido se envía por error. | Bloquea `listo_para_firma`. | Revisión humana obligatoria antes de firmar. |
| Clave expuesta. | Solo en entorno; nunca en respuestas ni logs (probado). | Gestor de secretos y rotación periódica. |
| Enlace público abierto a cualquiera gasta la clave. | Tope global de tokens (`TOKENS_GLOBALES`, 8 000 000 por defecto) además del tope por sesión; el servicio responde con pausa al agotarlo. | Autenticación con clave de acceso y presupuesto con alertas en el proveedor. |
| Clave de OpenAI expuesta durante el desarrollo. | Se usó solo para pruebas; se reemplazó por Anthropic. | Revocar la clave antigua en la consola del proveedor. |

## Anexo A. Matriz de controles

Cada control del PRD con el mecanismo que lo implementa y la prueba que lo verifica (`npm test`).

| Control | Mecanismo | Prueba |
|---|---|---|
| CA1 Tope de iteraciones | `MAX_ITER` en `ciclo.ts`; al alcanzarlo devuelve parciales y faltantes | `ciclo-agente.test.ts` (corta en el tope) |
| CA2 Solo valores de herramientas | Prompt + verificación determinista de identificadores, valores destacados y nombres propios contra las salidas de toda la sesión | `ciclo-agente.test.ts` (identificadores, nombres en negrita, nombres propios, frases normales, turnos anteriores) |
| CA3 Confirmación explícita | `actionId` de un uso y vigente en el turno siguiente; el modelo no ve `confirmado` | `api-chat.test.ts` (modelo no confirma, reuso rechazado), `gui-modal.test.ts` (Aceptar crea, Cancelar y Esc no) |
| CA4 Llamadas visibles y registradas | Historial del chat y `log.jsonl` | `armar-paquete.test.ts`, `demo-xlsx.test.ts` (línea de generación) |
| CA5 Errores claros, sesión viva | Clasificación de errores del proveedor (timeout, 429, 401, 5xx) | `ciclo-agente.test.ts` (429, timeout), `api-chat.test.ts` (sesión sigue) |
| RN1 Identificador tributario por país | `MAPA` y `requiere_confirmacion` fuera de CO; etiquetas ambiguas | `mapear-campos.test.ts` |
| RN2 Datos bancarios | Solo si la plantilla los pide; borrador sin banco | `generar-xlsx.test.ts` (HN sin banco, CO con banco), `armar-paquete.test.ts` (borrador sin banco) |
| RN3 Vencido/ausente bloquea, faltante no | `listo_para_firma` solo con soportes; faltantes en checklist | `armar-paquete.test.ts` |
| RN4 Confirmación antes de acción externa | `proveedor_simular_envio` exige `confirmado=true` | `simular-envio.test.ts`, `cableado.test.ts` |
| RN5 Registro por ejecución | `registrar()` en `BaseTool` escribe `log.jsonl` | `armar-paquete.test.ts`, `demo-xlsx.test.ts`, `demo-pdf.test.ts` |
| HU-1 Leer solicitud | `proveedor_leer_solicitud` (plantilla de campos o de celdas) | `leer-solicitud.test.ts` |
| HU-2 Mapear al maestro | Estados `llenos` / `faltantes` / `requiere_confirmacion`; glosario; confianza por similitud | `mapear-campos.test.ts`, `cumplimiento-prd.test.ts` (confianza) |
| HU-3 P0 Excel | Escritura en hoja y celda de `plantilla-celdas.json` | `generar-xlsx.test.ts`, `demo-xlsx.test.ts` |
| HU-3 P1 PDF | Etiquetas en orden de `plantilla-campos.json`, faltantes `(pendiente)` | `generar-pdf.test.ts`, `demo-pdf.test.ts` |
| HU-3 P2 Portal | `valores-portal.md` y aviso «formato no soportado» | `generar-portal.test.ts`, `demo-pa.test.ts`, `cumplimiento-prd.test.ts` |
| HU-4 Paquete para firma | Checklist, copias, formulario, borrador | `armar-paquete.test.ts`, `demo-xlsx.test.ts` |
| HU-5 Manejo de errores | `{ok,data}` / `{ok,error}` sin lanzar; caso inexistente; archivo corrupto con mensaje claro | `contrato-tools.test.ts`, `leer-solicitud.test.ts`, `demo-todos.test.ts`, `cumplimiento-prd.test.ts` |
| Seguridad: clave solo en entorno | `.env` ignorado; clave no aparece en respuestas ni en `out/` | `seguridad.test.ts` |
| Seguridad: sin shell, sin rutas absolutas | Escaneo del código y de los artefactos | `seguridad.test.ts` |
| Seguridad: anti-XSS, CSP, path traversal | Render como texto, `default-src 'self'`, slug de caso | `gui-modal.test.ts`, `contrato-tools.test.ts`, `seguridad.test.ts` |
| Costo: tope por sesión y global | `TOKENS_SESION` y `TOKENS_GLOBALES` | `api-chat.test.ts` |
| Determinismo | Fecha de referencia fija; `out/` se limpia; xlsx y pdf sin fechas internas | `demo-todos.test.ts` (y verificación manual de dos corridas: contenido idéntico) |
| Configuración documentada | Cada variable que lee la app está en `.env.example` | `config.test.ts` |
| Bonus modulo reutilizable | Mismas herramientas y textos que la app | `modulo.test.ts` |

## Anexo B. Decisión sobre el enlace

El enlace público es https://reto-01-proveedor.onrender.com. Si el día de la defensa no está activo, la defensa se hace en local con `npm run dev` y se asume la penalización de -10 que indica el PRD.
