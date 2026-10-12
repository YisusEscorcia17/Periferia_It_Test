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

**Verificación de valores (CA2).** Las herramientas son la única fuente de valores. Como verificación determinista, cada número de identificación (6 dígitos o más) de la respuesta debe aparecer en alguna salida exitosa de herramienta de la sesión. Si no aparece, la respuesta añade una advertencia `⚠ Valores no verificados por herramientas`. Esto cubre números, no texto libre; ver sección 10.

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
| HU-1 Leer la solicitud | Hecho | — |
| HU-2 Mapear campos al maestro | Hecho | Verificación de texto libre (CA2 parcial, sección 10). |
| HU-3 P0 Excel (`formulario.xlsx`) | Hecho | — |
| HU-3 P1 PDF (`formulario.pdf`) | Hecho | — |
| HU-3 P2 Portal (`valores-portal.md`) | Hecho | — |
| HU-4 Paquete para firma | Hecho | — |
| HU-5 Manejo de errores | Hecho | Mensajes de error de herramienta más amigables en el front. |
| Chat: historial, tool-calls, pensando, diálogo, CSP, anti-XSS | Hecho | Pruebas visuales en navegador real. |
| RN1 Identificador tributario por país | Hecho | — |
| RN2 Borrador sin banco | Hecho | — |
| RN3 Vencido/ausente bloquea, faltante no | Hecho | — |
| RN4 Confirmación antes de acción externa | Hecho | — |
| RN5 Log por ejecución | Hecho | — |
| CA1 Tope de iteraciones | Hecho | — |
| CA2 Solo valores de herramientas | Parcial | Verificación semántica de texto libre. |
| CA3 Confirmación explícita | Hecho | — |
| CA4 Llamadas visibles y en log | Hecho | — |
| CA5 Errores claros, sesión viva | Hecho | — |
| `demo.ts` sobre todos los casos | Hecho | — |
| Costo: tope de tokens configurable | Hecho | Tabla de precios para el costo en dólares. |
| Seguridad: clave solo en entorno, sin shell | Hecho | Revisión externa. |
| TypeScript sin `any` | Hecho | Verificado con búsqueda en `src/`, `tests/` y `demo.ts`. |
| Enlace público de prueba (9.3) | Preparado | `render.yaml` listo (build, health check, variables). Falta conectar el repositorio en Render y cargar `ANTHROPIC_API_KEY`. La instalación de producción (`npm ci --omit=dev`) se probó en una copia limpia. |
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
| El modelo inventa un valor de texto libre (nombre, dirección). | Prompt (CA2); verificación de números; las herramientas son la única fuente. | Verificación semántica de cada valor citado, o salida estructurada. |
| El modelo cambia de comportamiento con una actualización. | Pruebas de integración con el adaptador y medición real por cambio. | Evaluación automatizada con casos dorados antes de cada cambio de modelo. |
| Costo descontrolado. | `TOKENS_SESION` y `MAX_ITER`. | Presupuesto mensual y alertas en el proveedor. |
| Sesiones en memoria se pierden al reiniciar. | Aceptable para el reto (sin persistencia en PRD). | Almacén de sesiones en archivo o base de datos. |
| Datos del maestro desactualizados. | Supuesto explícito (PRD 10). | Un dueño del dato y fecha de última actualización visible. |
| Un soporte vencido se envía por error. | Bloquea `listo_para_firma`. | Revisión humana obligatoria antes de firmar. |
| Clave expuesta. | Solo en entorno; nunca en respuestas ni logs (probado). | Gestor de secretos y rotación periódica. |
| Enlace público abierto a cualquiera gasta la clave. | Tope global de tokens (`TOKENS_GLOBALES`, 2 000 000 por defecto) además del tope por sesión; el servicio responde con pausa al agotarlo. | Autenticación con clave de acceso y presupuesto con alertas en el proveedor. |
| Clave de OpenAI expuesta durante el desarrollo. | Se usó solo para pruebas; se reemplazó por Anthropic. | Revocar la clave antigua en la consola del proveedor. |
